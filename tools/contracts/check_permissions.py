"""Fail when a permission is used but never granted, or granted without an explicit scope.

    python tools/contracts/check_permissions.py

Sources: 21_SECURITY/roles.reference.json (grants, scopes, segregation),
06_API_CONTRACTS/openapi.yaml (x-permission), 13_AI_PROMPTS_AND_TOOLS/tools.json,
19_SCREEN_INVENTORY/screens.json and screens.csv (must agree).
"""
from __future__ import annotations

import csv
import json
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
ROLES = ROOT / "21_SECURITY/roles.reference.json"
OPENAPI = ROOT / "06_API_CONTRACTS/openapi.yaml"
TOOLS = ROOT / "13_AI_PROMPTS_AND_TOOLS/tools.json"
SCREENS_JSON = ROOT / "19_SCREEN_INVENTORY/screens.json"
SCREENS_CSV = ROOT / "19_SCREEN_INVENTORY/screens.csv"
PERM = re.compile(r"[a-z]+\.[a-z]+")


def api_permissions(api: dict) -> dict[str, str]:
    out = {}
    for path, ops in api["paths"].items():
        for method, op in ops.items():
            if isinstance(op, dict) and "operationId" in op:
                out[op["operationId"]] = op.get("x-permission", "")
    return out


def check(roles_doc: dict, api: dict, tools: list, screens: list, screens_csv: list) -> list[str]:
    errs: list[str] = []
    if roles_doc.get("default") != "DENY":
        errs.append("roles.reference.json: default must be DENY")
    roles = roles_doc["roles"]
    scopes = roles_doc.get("scopes", {})
    vocab = roles_doc.get("scopeVocabulary", {})
    granted = {p for perms in roles.values() for p in perms}

    for role, perms in roles.items():
        if len(perms) != len(set(perms)):
            errs.append(f"{role}: duplicated grants")
        for p in perms:
            if "*" in p or not PERM.fullmatch(p):
                errs.append(f"{role}: invalid or wildcard permission {p!r}")
            scope = scopes.get(role, {}).get(p)
            if scope is None:
                errs.append(f"{role}: grant {p} has no scope")
            elif scope not in vocab:
                errs.append(f"{role}: grant {p} uses unknown scope {scope!r}")
        for p in scopes.get(role, {}):
            if p not in perms:
                errs.append(f"{role}: scope declared for {p}, which is not granted")
    for role in scopes:
        if role not in roles:
            errs.append(f"scopes: unknown role {role}")

    for op_id, perm in api_permissions(api).items():
        if not perm:
            errs.append(f"OpenAPI {op_id}: no x-permission")
        elif perm not in granted:
            errs.append(f"OpenAPI {op_id}: permission {perm} is granted to no role")
    for t in tools:
        if t["permission"] not in granted:
            errs.append(f"tool {t['name']}: permission {t['permission']} is granted to no role")

    for s in screens:
        if s["permission"] == "public":
            continue
        if s["role"] not in roles:
            errs.append(f"screen {s['id']}: unknown role {s['role']}")
        elif s["permission"] not in roles[s["role"]]:
            errs.append(f"screen {s['id']}: role {s['role']} lacks {s['permission']}")

    by_id = {r["id"]: r for r in screens_csv}
    if len(by_id) != len(screens):
        errs.append(f"screens.csv has {len(by_id)} rows, screens.json {len(screens)}")
    for s in screens:
        row = by_id.get(s["id"])
        if row is None:
            errs.append(f"screen {s['id']} missing from screens.csv")
        elif (row["role"], row["permission"]) != (s["role"], s["permission"]):
            errs.append(f"screen {s['id']}: csv and json disagree on role/permission")

    for rule in roles_doc.get("segregation", []):
        a, b = rule["author"], rule["publisher"]
        for role, perms in roles.items():
            if a in perms and b in perms:
                errs.append(f"{role}: holds both {a} and {b} ({rule['rule']})")
    return errs


def load() -> tuple:
    with SCREENS_CSV.open(encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    return (json.loads(ROLES.read_text()), yaml.safe_load(OPENAPI.read_text()),
            json.loads(TOOLS.read_text()), json.loads(SCREENS_JSON.read_text()), rows)


def main() -> int:
    errs = check(*load())
    for e in errs:
        print(f"PERMISSION: {e}")
    if errs:
        return 1
    roles = json.loads(ROLES.read_text())["roles"]
    print(f"permissions OK: {len(roles)} roles, {sum(map(len, roles.values()))} scoped grants")
    return 0


if __name__ == "__main__":
    sys.exit(main())
