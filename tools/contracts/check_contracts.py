"""Fail when SQL or OpenAPI state values drift from 08_STATE_MACHINES/machines.json,
or when a machine action has no trigger in 08_STATE_MACHINES/transitions.json,
or when OpenAPI Event / SQL outbox drift from 07_DOMAIN_MODELS/event.schema.json,
or when an error code used by services/ or OpenAPI is not in 06_API_CONTRACTS/errors.json.

    python tools/contracts/check_contracts.py            # check, exit 1 on drift
    python tools/contracts/check_contracts.py --emit     # print the OpenAPI state schemas

Also checks each machine is well formed: the initial state exists, every state is
reachable from it, and every transition has an action.
"""
from __future__ import annotations

import argparse
import ast
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
TOOLS = ROOT / "13_AI_PROMPTS_AND_TOOLS/tools.json"
FAMILIES = ROOT / "11_3D_ASSET_LIBRARY/families.json"
TRANSITIONS = ROOT / "08_STATE_MACHINES/transitions.json"
EVENT = ROOT / "07_DOMAIN_MODELS/event.schema.json"
ERRORS = ROOT / "06_API_CONTRACTS/errors.json"
SERVICES = ROOT / "services"
CODE = re.compile(r"[A-Z][A-Z0-9]*(_[A-Z0-9]+)*")
# Envelope field -> SQL outbox column.
OUTBOX_COLUMNS = {
    "eventId": "id", "eventType": "event_type", "schemaVersion": "schema_version",
    "aggregateId": "aggregate_id", "aggregateVersion": "aggregate_version", "occurredAt": "occurred_at",
    "correlationId": "correlation_id", "causationId": "causation_id", "payload": "payload",
}
VIA = {"api", "provider-webhook", "system", "worker", "pending"}


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


def design_operations(tools: list) -> dict:
    """OpenAPI DesignOperation variants: one per PREVIEW tool, discriminated by `type`.

    tools.json is the allowlist: an operation the AI or the app can propose must be a
    PREVIEW tool, and its arguments are exactly that tool's inputSchema.
    """
    variants = {}
    for t in tools:
        if t["executionMode"] != "PREVIEW":
            continue
        schema = t["inputSchema"]
        variants[t["name"]] = {
            "type": "object",
            "properties": {"type": {"const": t["name"]}, **schema["properties"]},
            "required": ["type", *schema["required"]],
            "additionalProperties": False,
        }
    return variants


def check_operations(tools: list, openapi: dict) -> list[str]:
    errs = []
    schemas = openapi["components"]["schemas"]
    expected = design_operations(tools)
    op = schemas.get("DesignOperation")
    if op is None:
        return ["OpenAPI has no DesignOperation schema"]
    refs = [r["$ref"].rsplit("/", 1)[-1] for r in op.get("oneOf", [])]
    mapping = op.get("discriminator", {}).get("mapping", {})
    if op.get("discriminator", {}).get("propertyName") != "type":
        errs.append("DesignOperation must use discriminator propertyName `type`")
    want = {name: _op_schema_name(name) for name in expected}
    if sorted(refs) != sorted(want.values()):
        errs.append(f"DesignOperation variants {sorted(refs)} != PREVIEW tools {sorted(want.values())}")
    for name, sname in want.items():
        if mapping.get(name, "").rsplit("/", 1)[-1] != sname:
            errs.append(f"DesignOperation discriminator mapping for {name} must point to {sname}")
        if schemas.get(sname) != expected[name]:
            errs.append(f"OpenAPI {sname} differs from tools.json {name} inputSchema")
    return errs


def check_create_ring_ranges(tools: list, families: list) -> list[str]:
    """create_ring must accept exactly the ring.classic parameter ranges (families.json is canonical)."""
    tool = next(t for t in tools if t["name"] == "create_ring")
    fam = next(f for f in families if f["id"] == "ring.classic")
    errs = []
    props = tool["inputSchema"]["properties"]
    for name, rng in fam["parameters"].items():
        p = props.get(name)
        if p is None:
            errs.append(f"create_ring lacks ring.classic parameter {name}")
        elif (p.get("minimum"), p.get("maximum")) != (rng["min"], rng["max"]):
            errs.append(f"create_ring.{name} range {p.get('minimum')}-{p.get('maximum')} != ring.classic {rng['min']}-{rng['max']}")
    return errs


def _operations(openapi: dict) -> dict[str, tuple[str, dict]]:
    out = {}
    for ops in openapi["paths"].values():
        for method, op in ops.items():
            if isinstance(op, dict) and "operationId" in op:
                out[op["operationId"]] = (method, op)
    return out


def _response_state(op: dict, schemas: dict) -> str | None:
    """Name of the state schema carried by the operation's first 2xx JSON response."""
    for code in sorted(op.get("responses", {})):
        if code.startswith("2"):
            ref = (op["responses"][code].get("content", {}).get("application/json", {})
                   .get("schema", {}).get("$ref", ""))
            sch = schemas.get(ref.rsplit("/", 1)[-1], {})
            return sch.get("properties", {}).get("state", {}).get("$ref", "").rsplit("/", 1)[-1] or None
    return None


def check_transitions(machines: dict, bindings: dict, transitions: dict, openapi: dict) -> list[str]:
    """Every machine action has a trigger: an API operation, a provider event, a system rule,
    a worker, or an explicit pending milestone. API operations must exist, be POST, require an
    Idempotency-Key, and return the machine's own state (or the declared `returns` machine)."""
    errs = []
    schemas = openapi["components"]["schemas"]
    ops = _operations(openapi)
    for name, m in machines.items():
        entries = transitions.get(name)
        if entries is None:
            errs.append(f"transitions.json: machine {name} missing")
            continue
        actions = {t["action"] for t in m["transitions"]}
        for a in sorted(actions - entries.keys()):
            errs.append(f"{name}.{a}: no trigger in transitions.json")
        for a in sorted(entries.keys() - actions):
            errs.append(f"{name}.{a}: not an action of the machine")
        for a, e in entries.items():
            via = e.get("via")
            if via not in VIA:
                errs.append(f"{name}.{a}: unknown via {via!r}")
            elif via == "pending" and not e.get("milestone"):
                errs.append(f"{name}.{a}: pending without milestone")
            elif via == "api":
                op_id = e.get("operationId")
                if op_id not in ops:
                    errs.append(f"{name}.{a}: operation {op_id} not in OpenAPI")
                    continue
                method, op = ops[op_id]
                if method != "post":
                    errs.append(f"{name}.{a}: {op_id} must be POST")
                if not any(p.get("in") == "header" and p.get("name") == "Idempotency-Key" and p.get("required")
                           for p in op.get("parameters", [])):
                    errs.append(f"{name}.{a}: {op_id} lacks a required Idempotency-Key")
                target = e.get("returns", name)
                want = bindings.get(target, {}).get("openapi")
                got = _response_state(op, schemas)
                if want and got != want:
                    errs.append(f"{name}.{a}: {op_id} returns state {got}, expected {want}")
    for name in transitions:
        if not name.startswith("$") and name not in machines:
            errs.append(f"transitions.json: unknown machine {name}")
    return errs


DIGEST_BOUND = ("acceptQuote", "rejectQuote", "issueQuote", "submitDesign", "approveDesign", "returnDesign")


def check_digest_bound(openapi: dict) -> list[str]:
    """Decisions on a quote or a revision bind the exact version the user saw."""
    errs = []
    ops = _operations(openapi)
    for op_id in DIGEST_BOUND:
        if op_id not in ops:
            errs.append(f"OpenAPI has no {op_id}")
            continue
        body = (ops[op_id][1].get("requestBody", {}).get("content", {})
                .get("application/json", {}).get("schema", {}))
        if "expectedDigest" not in body.get("required", []):
            errs.append(f"{op_id}: requestBody must require expectedDigest")
    if "digest" not in schemas_required(openapi, "Quote"):
        errs.append("Quote: digest must be required")
    return errs


def schemas_required(openapi: dict, name: str) -> list[str]:
    return openapi["components"]["schemas"].get(name, {}).get("required", [])


def event_schema(envelope: dict) -> dict:
    """OpenAPI `Event`: the envelope without its JSON Schema header."""
    return {k: v for k, v in envelope.items() if k not in ("$schema", "title")}


def emit_event(envelope: dict) -> str:
    body = yaml.safe_dump({"Event": event_schema(envelope)}, sort_keys=False, allow_unicode=True, width=1000)
    return "".join("    " + line + "\n" for line in body.splitlines())


def outbox_columns(sql: str) -> dict[str, str] | None:
    """outbox column -> its definition text, or None when the table is missing."""
    m = re.search(r"CREATE TABLE outbox\((.*?)\);\s*\n", sql, re.S)
    if m is None:
        return None
    cols, depth, cur = {}, 0, ""
    for ch in m.group(1) + ",":
        if ch == "," and depth == 0:
            name = cur.strip().split(" ", 1)
            if name[0] and name[0].upper() not in ("UNIQUE", "CHECK", "PRIMARY"):
                cols[name[0]] = name[1] if len(name) > 1 else ""
            cur = ""
            continue
        depth += (ch == "(") - (ch == ")")
        cur += ch
    return cols


def check_events(envelope: dict, openapi: dict, sql: str) -> list[str]:
    """One envelope: OpenAPI Event and SQL outbox follow 07_DOMAIN_MODELS/event.schema.json."""
    errs = []
    if openapi["components"]["schemas"].get("Event") != event_schema(envelope):
        errs.append("OpenAPI Event differs from 07_DOMAIN_MODELS/event.schema.json (--emit prints it)")
    cols = outbox_columns(sql)
    if cols is None:
        return errs + ["SQL has no outbox table"]
    required = set(envelope["required"])
    fields = set(envelope["properties"])
    if fields != set(OUTBOX_COLUMNS):
        errs.append(f"OUTBOX_COLUMNS {sorted(OUTBOX_COLUMNS)} != envelope fields {sorted(fields)}")
    for field, col in OUTBOX_COLUMNS.items():
        if col not in cols:
            errs.append(f"SQL outbox lacks column {col} for {field}")
            continue
        not_null = "NOT NULL" in cols[col] or "PRIMARY KEY" in cols[col]
        if (field in required) != not_null:
            errs.append(f"SQL outbox.{col}: NOT NULL must match envelope required ({field})")
    if not re.search(r"UNIQUE\(aggregate_id,\s*aggregate_version\)", sql):
        errs.append("SQL outbox needs UNIQUE(aggregate_id, aggregate_version) to detect gaps and duplicates")
    return errs


def service_error_codes(root: Path = SERVICES) -> dict[str, str]:
    """Stable codes raised in services/*/aurea_*: class `code = "X"`, `code="X"` keywords,
    and the first argument of `ValidationIssue("X", ...)`. Returns code -> first file."""
    out: dict[str, str] = {}
    for f in sorted(root.glob("*/aurea_*/*.py")):
        rel = str(f.relative_to(ROOT)) if f.is_relative_to(ROOT) else str(f)
        for n in ast.walk(ast.parse(f.read_text(encoding="utf-8"))):
            found = []
            if isinstance(n, ast.ClassDef):
                found += [b.value.value for b in n.body if isinstance(b, ast.Assign)
                          and any(isinstance(t, ast.Name) and t.id == "code" for t in b.targets)
                          and isinstance(b.value, ast.Constant)]
            if isinstance(n, ast.Call):
                found += [k.value.value for k in n.keywords if k.arg == "code" and isinstance(k.value, ast.Constant)]
                name = getattr(n.func, "id", getattr(n.func, "attr", None))
                if name == "ValidationIssue" and n.args and isinstance(n.args[0], ast.Constant):
                    found.append(n.args[0].value)
            for c in found:
                out.setdefault(c, rel)
    return out


def check_errors(catalog: dict, openapi: dict, used: dict[str, str]) -> list[str]:
    errs = []
    schemas = openapi["components"]["schemas"]
    seen: dict[str, dict] = {}
    for e in catalog["codes"]:
        c = e["code"]
        if c in seen:
            errs.append(f"errors.json: {c} repeated")
        seen[c] = e
        if not CODE.fullmatch(c):
            errs.append(f"errors.json: {c!r} is not UPPER_SNAKE")
        if e["use"] == "error" and not (isinstance(e.get("http"), int) and 400 <= e["http"] <= 599):
            errs.append(f"errors.json: {c} needs an HTTP status 4xx/5xx")
        if e["use"] == "detail" and e.get("http") is not None:
            errs.append(f"errors.json: detail code {c} must not carry an HTTP status")
        if e["use"] not in ("error", "detail"):
            errs.append(f"errors.json: {c} has unknown use {e['use']!r}")
    for c, f in sorted(used.items()):
        if c not in seen:
            errs.append(f"{f}: error code {c} is not in 06_API_CONTRACTS/errors.json")
    pattern = schemas.get("ErrorCode", {}).get("pattern")
    if pattern is None or not all(re.fullmatch(pattern.strip("^$"), c) for c in seen):
        errs.append("OpenAPI ErrorCode pattern missing or rejects a catalogued code")
    err = schemas.get("Error", {}).get("properties", {})
    if err.get("code", {}).get("$ref", "").rsplit("/", 1)[-1] != "ErrorCode":
        errs.append("OpenAPI Error.code must use ErrorCode")
    if err.get("details", {}).get("items", {}).get("$ref", "").rsplit("/", 1)[-1] != "ErrorDetail":
        errs.append("OpenAPI Error.details must be an array of ErrorDetail")
    statuses = {str(e["http"]) for e in catalog["codes"] if e["use"] == "error"}
    for ops in openapi["paths"].values():
        for op in ops.values():
            if not isinstance(op, dict) or "operationId" not in op:
                continue
            for code, r in op.get("responses", {}).items():
                ref = r.get("content", {}).get("application/json", {}).get("schema", {}).get("$ref", "")
                if ref.endswith("/Error") and code not in statuses:
                    errs.append(f"{op['operationId']}: response {code} has no catalogued error code")
    return errs


def _op_schema_name(tool: str) -> str:
    return "Op" + "".join(p.capitalize() for p in tool.split("_"))


def emit_operations(tools: list) -> str:
    variants = design_operations(tools)
    out = ["    DesignOperation:\n",
           "      description: Generado de 13_AI_PROMPTS_AND_TOOLS/tools.json (herramientas PREVIEW). No editar a mano.\n",
           "      oneOf:\n"]
    out += [f"      - $ref: '#/components/schemas/{_op_schema_name(n)}'\n" for n in variants]
    out += ["      discriminator:\n", "        propertyName: type\n", "        mapping:\n"]
    out += [f"          {n}: '#/components/schemas/{_op_schema_name(n)}'\n" for n in variants]
    for n, sch in variants.items():
        body = yaml.safe_dump({_op_schema_name(n): sch}, sort_keys=False, allow_unicode=True)
        out.append("".join("    " + line + "\n" for line in body.splitlines()))
    return "".join(out)


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
    tools = json.loads(TOOLS.read_text())
    if args.emit:
        print(emit(machines, bindings) + emit_operations(tools) + emit_event(json.loads(EVENT.read_text())), end="")
        return 0
    api = yaml.safe_load(OPENAPI.read_text())
    families = json.loads(FAMILIES.read_text())
    families = families if isinstance(families, list) else families["families"]
    transitions = json.loads(TRANSITIONS.read_text())
    sql = SQL.read_text()
    errs = (check(machines, bindings, sql, api) + check_operations(tools, api)
            + check_create_ring_ranges(tools, families)
            + check_transitions(machines, bindings, transitions, api) + check_digest_bound(api)
            + check_events(json.loads(EVENT.read_text()), api, sql)
            + check_errors(json.loads(ERRORS.read_text()), api, service_error_codes()))
    if not re.search(r"CREATE TABLE quote\([^;]*\bdigest char\(64\) NOT NULL", sql):
        errs.append("SQL quote has no `digest char(64) NOT NULL`")
    for e in errs:
        print(f"DRIFT: {e}")
    if errs:
        return 1
    print(f"contracts OK: {sum(1 for k in bindings if not k.startswith('$'))} machines checked")
    return 0


if __name__ == "__main__":
    sys.exit(main())
