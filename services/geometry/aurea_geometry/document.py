"""DesignDocument validation: JSON schema plus semantic checks.

Schema validation alone is not enough (ENGINE.md): ranges, finiteness,
known families/versions, unknown parameters and dependency cycles are
checked here and reported as structured errors, never silently fixed.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
from dataclasses import dataclass
from pathlib import Path

import jsonschema

from .families import FAMILIES

# Repo layout: services/geometry/aurea_geometry/ -> repo root is parents[3].
SCHEMA_PATH = Path(
    os.environ.get(
        "AUREA_DESIGN_SCHEMA",
        Path(__file__).resolve().parents[3] / "09_JEWELRY_ENGINE" / "design.schema.json",
    )
)


COMPONENT_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")


@dataclass(frozen=True)
class ValidationIssue:
    code: str
    path: str
    message: str


class InvalidDocument(ValueError):
    def __init__(self, issues: list[ValidationIssue]):
        self.issues = issues
        super().__init__("; ".join(f"{i.code} {i.path}: {i.message}" for i in issues))


def canonical_digest(document: dict) -> str:
    """SHA-256 over canonical JSON (sorted keys, no whitespace)."""
    data = json.dumps(document, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


def _load_schema(schema_path: Path | None) -> dict:
    return json.loads((schema_path or SCHEMA_PATH).read_text(encoding="utf-8"))


def validate_document(document: dict, schema_path: Path | None = None) -> None:
    issues: list[ValidationIssue] = []
    validator = jsonschema.Draft202012Validator(_load_schema(schema_path))
    for err in sorted(validator.iter_errors(document), key=lambda e: list(e.path)):
        issues.append(
            ValidationIssue("SCHEMA", "/" + "/".join(map(str, err.path)), err.message)
        )
    if issues:
        raise InvalidDocument(issues)

    ids = [c["id"] for c in document["components"]]
    seen: set[str] = set()
    for i, cid in enumerate(ids):
        # Ids become artifact file names: restrict to a safe charset (no path traversal).
        if not COMPONENT_ID.fullmatch(cid):
            issues.append(ValidationIssue("INVALID_ID", f"/components/{i}/id", repr(cid)))
        if cid in seen:
            issues.append(ValidationIssue("DUPLICATE_ID", f"/components/{i}/id", cid))
        seen.add(cid)

    for i, comp in enumerate(document["components"]):
        base = f"/components/{i}"
        fam = FAMILIES.get(comp["family"])
        if fam is None:
            issues.append(ValidationIssue("UNKNOWN_FAMILY", base + "/family", comp["family"]))
            continue
        if comp["familyVersion"] != fam.version:
            issues.append(
                ValidationIssue(
                    "UNSUPPORTED_FAMILY_VERSION",
                    base + "/familyVersion",
                    f"{comp['familyVersion']} (supported: {fam.version})",
                )
            )
        params = comp["parameters"]
        for name in params.keys() - fam.params.keys():
            issues.append(ValidationIssue("UNKNOWN_PARAMETER", f"{base}/parameters/{name}", name))
        for name, spec in fam.params.items():
            p = f"{base}/parameters/{name}"
            if name not in params:
                issues.append(ValidationIssue("MISSING_PARAMETER", p, name))
                continue
            v = params[name]
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                issues.append(ValidationIssue("NOT_A_NUMBER", p, repr(v)))
            elif not math.isfinite(v):
                issues.append(ValidationIssue("NOT_FINITE", p, repr(v)))
            elif not spec.minimum <= v <= spec.maximum:
                issues.append(
                    ValidationIssue(
                        "OUT_OF_RANGE", p, f"{v} not in [{spec.minimum}, {spec.maximum}] {spec.unit}"
                    )
                )
        t = comp["transform"]
        nums = t["translation"] + t["rotationQuaternion"]
        if not all(math.isfinite(x) for x in nums):
            issues.append(ValidationIssue("NOT_FINITE", base + "/transform", "non-finite transform"))
        else:
            norm = math.sqrt(sum(q * q for q in t["rotationQuaternion"]))
            if abs(norm - 1.0) > 1e-6:
                issues.append(
                    ValidationIssue("QUATERNION_NOT_NORMALIZED", base + "/transform", f"|q|={norm}")
                )
        for dep in comp["dependsOn"]:
            if dep not in seen:
                issues.append(ValidationIssue("DANGLING_DEPENDENCY", base + "/dependsOn", dep))

    graph = {c["id"]: list(c["dependsOn"]) for c in document["components"]}
    if _has_cycle(graph):
        issues.append(ValidationIssue("DEPENDENCY_CYCLE", "/components", "dependsOn has a cycle"))

    for i, con in enumerate(document["constraints"]):
        if con["target"] not in seen:
            issues.append(ValidationIssue("DANGLING_TARGET", f"/constraints/{i}/target", con["target"]))
        if con["type"] == "min_wall":
            mm = con["parameters"].get("minMm")
            if isinstance(mm, bool) or not isinstance(mm, (int, float)) or not math.isfinite(mm) or mm <= 0:
                issues.append(ValidationIssue("INVALID_CONSTRAINT", f"/constraints/{i}", "minMm must be > 0"))

    if document["operations"]:
        # No feature operations are implemented in hito 000; refuse instead of ignoring.
        issues.append(ValidationIssue("UNSUPPORTED_OPERATION", "/operations", "operations not supported yet"))

    if issues:
        raise InvalidDocument(issues)


def _has_cycle(graph: dict[str, list[str]]) -> bool:
    state: dict[str, int] = {}

    def visit(n: str) -> bool:
        if state.get(n) == 1:
            return True
        if state.get(n) == 2 or n not in graph:
            return False
        state[n] = 1
        if any(visit(d) for d in graph[n]):
            return True
        state[n] = 2
        return False

    return any(visit(n) for n in graph)
