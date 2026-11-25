"""Canonical JSON for digests, shared with the TypeScript side.

RFC 8785 (JCS) subset for the values a DesignDocument can hold: objects with
string keys sorted by UTF-16 code units, arrays, strings, booleans, null and
finite numbers written the way ECMAScript's Number.prototype.toString does.
`packages/design` implements the same rules; both sides are tested against
`09_JEWELRY_ENGINE/fixtures/digests.json`, so the API (TypeScript) and this
worker compute the same revision digest for the same document.
"""
from __future__ import annotations

import hashlib
import json
import math
from decimal import Decimal


def _number(x: float | int) -> str:
    if isinstance(x, bool):
        raise TypeError("bool is not a number")
    if isinstance(x, int):
        if abs(x) <= 2**53:
            return str(x)
        x = float(x)  # what an ECMAScript parser would hold for this JSON number
    if not math.isfinite(x):
        raise ValueError("non-finite number")
    if x == 0:
        return "0"
    # repr() is the shortest round-trip form, like ECMAScript; only the exponent
    # notation differs (Python "1e-07", ECMAScript "1e-7"; ECMAScript switches
    # to exponents at 1e21 and below 1e-6).
    digits, exp = _decompose(abs(x))
    n = exp + 1  # position of the decimal point relative to the digits
    k = len(digits)
    sign = "-" if x < 0 else ""
    if k <= n <= 21:
        return sign + digits + "0" * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + digits
    e = n - 1
    mant = digits[0] + ("." + digits[1:] if k > 1 else "")
    return f"{sign}{mant}e{'+' if e >= 0 else '-'}{abs(e)}"


def _decompose(x: float) -> tuple[str, int]:
    """Shortest round-trip digits of x > 0 and the decimal exponent of its first digit."""
    _, digits, exp = Decimal(repr(x)).as_tuple()
    text = "".join(map(str, digits))
    lead = len(text) - len(text.lstrip("0"))
    text = text[lead:]
    # value = int(text) * 10**exp, so the first digit sits at 10**(len(text) - 1 + exp).
    return text.rstrip("0"), len(text) - 1 + exp


def _utf16_key(s: str) -> list[int]:
    return list(s.encode("utf-16-be"))


def canonical_json(value) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        return _number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(v) for v in value) + "]"
    if isinstance(value, dict):
        if not all(isinstance(k, str) for k in value):
            raise TypeError("object keys must be strings")
        items = sorted(value.items(), key=lambda kv: _utf16_key(kv[0]))
        return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + canonical_json(v) for k, v in items) + "}"
    raise TypeError(f"unsupported type {type(value).__name__}")


def canonical_digest(value) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()
