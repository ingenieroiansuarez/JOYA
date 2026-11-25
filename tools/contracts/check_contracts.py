"""Fail when SQL or OpenAPI state values drift from 08_STATE_MACHINES/machines.json.

    python tools/contracts/check_contracts.py            # check, exit 1 on drift
    python tools/contracts/check_contracts.py --emit     # print the OpenAPI state schemas

Also checks each machine is well formed: the initial state exists, every state is
reachable from it, and every transition has an action.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
MACHINES = ROOT / "08_STATE_MACHINES/machines.json"
BINDINGS = ROOT / "08_STATE_MACHINES/bindings.json"
SQL = ROOT / "05_DATABASE/core_reference.sql"
OPENAPI = ROOT / "06_API_CONTRACTS/openapi.yaml"


def machine_states(machine: dict) -> list[str]:
    """States in first-seen order: initial, then each transition's from/to."""
    out = [machine["initial"]]
    for t in machine["transitions"]:
        for s in (t["from"], t["to"]):
            if s not in out:
                out.append(s)
    return out


def check_machine(name: str, machine: dict) -> list[str]:
    errs = []
    states = machine_states(machine)
    reach, frontier = {machine["initial"]}, [machine["initial"]]
    while frontier:
        cur = frontier.pop()
        for t in machine["transitions"]:
            if t["from"] == cur and t["to"] not in reach:
                reach.add(t["to"])
                frontier.append(t["to"])
    for s in states:
        if s not in reach:
            errs.append(f"{name}: state {s} is not reachable from {machine['initial']}")
        if not re.fullmatch(r"[A-Z][A-Z0-9_]*", s):
            errs.append(f"{name}: state {s!r} is not UPPER_SNAKE")
    for t in machine["transitions"]:
        if not t.get("action"):
            errs.append(f"{name}: transition {t['from']}->{t['to']} has no action")
    return errs


def sql_checks(sql: str) -> dict[str, list[str]]:
    """'table.column' -> values of `column text ... CHECK(column IN (...))`."""
    out = {}
    for table, body in re.findall(r"CREATE TABLE (\w+)\((.*?)\);\s*\n", sql, re.S):
        for col, vals in re.findall(r"\b(\w+) text NOT NULL(?: DEFAULT '\w+')? CHECK\(\1 IN \(([^)]*)\)\)", body):
            out[f"{table}.{col}"] = re.findall(r"'([^']*)'", vals)
        for col, default in re.findall(r"\b(\w+) text NOT NULL DEFAULT '(\w+)'", body):
            out[f"{table}.{col}#default"] = [default]
    return out


def check(machines: dict, bindings: dict, sql: str, openapi: dict) -> list[str]:
    errs: list[str] = []
    schemas = openapi["components"]["schemas"]
    sqlc = sql_checks(sql)
    for name in machines:
        if name not in bindings:
            errs.append(f"{name}: missing from bindings.json")
    for name, b in bindings.items():
        if name.startswith("$"):
            continue
        if name not in machines:
            errs.append(f"bindings.json: unknown machine {name}")
            continue
        m = machines[name]
        errs += check_machine(name, m)
        expected = machine_states(m)
        if b.get("sql"):
            got = sqlc.get(b["sql"])
            if got is None:
                errs.append(f"{name}: SQL has no `{b['sql']} text NOT NULL CHECK(... IN (...))`")
            elif set(got) != set(expected):
                errs.append(f"{name}: SQL {b['sql']} {sorted(got)} != machine {sorted(expected)}")
            default = sqlc.get(f"{b['sql']}#default")
            if default and default[0] != m["initial"]:
                errs.append(f"{name}: SQL default {default[0]} != initial {m['initial']}")
        if b.get("openapi"):
            sch = schemas.get(b["openapi"])
            if sch is None:
                errs.append(f"{name}: OpenAPI has no schema {b['openapi']}")
            elif sch.get("enum") != expected:
                errs.append(f"{name}: OpenAPI {b['openapi']} {sch.get('enum')} != machine {expected}")
        if not b.get("sql") and not b.get("openapi") and not b.get("pending"):
            errs.append(f"{name}: unbound and no `pending` note")
    # Every `state` property must use a bound state schema, never a free string.
    bound = {b["openapi"] for k, b in bindings.items() if not k.startswith("$") and b.get("openapi")}
    for sname, sch in schemas.items():
        st = sch.get("properties", {}).get("state")
        if st is None:
            continue
        ref = st.get("$ref", "").rsplit("/", 1)[-1]
        if ref not in bound and sname not in bindings.get("$unboundStateProperties", {}):
            errs.append(f"OpenAPI {sname}.state is not a machine-bound state schema")
    return errs


def emit(machines: dict, bindings: dict) -> str:
    out = []
    for name, b in bindings.items():
        if name.startswith("$") or not b.get("openapi"):
            continue
        out.append(f"    {b['openapi']}:\n      description: Generado de 08_STATE_MACHINES/machines.json ({name}). No editar a mano.\n"
                   "      type: string\n      enum:\n" + "".join(f"      - {s}\n" for s in machine_states(machines[name])))
    return "".join(out)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--emit", action="store_true")
    args = ap.parse_args(argv)
    machines = json.loads(MACHINES.read_text())
    bindings = json.loads(BINDINGS.read_text())
    if args.emit:
        print(emit(machines, bindings), end="")
        return 0
    errs = check(machines, bindings, SQL.read_text(), yaml.safe_load(OPENAPI.read_text()))
    for e in errs:
        print(f"DRIFT: {e}")
    if errs:
        return 1
    print(f"contracts OK: {sum(1 for k in bindings if not k.startswith('$'))} machines checked")
    return 0


if __name__ == "__main__":
    sys.exit(main())
