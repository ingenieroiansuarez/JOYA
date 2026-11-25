import copy
import json
import subprocess
import unittest
from pathlib import Path

import yaml
from jsonschema import Draft202012Validator

import check_contracts as cc

ROOT = Path(__file__).resolve().parents[2]


def load():
    return (
        json.loads(cc.MACHINES.read_text()),
        json.loads(cc.BINDINGS.read_text()),
        cc.SQL.read_text(),
        yaml.safe_load(cc.OPENAPI.read_text()),
    )


class ContractsTest(unittest.TestCase):
    def test_current_contracts_are_consistent(self):
        self.assertEqual(cc.check(*load()), [])

    def test_handoff_v1_drift_is_detected(self):
        """The contracts as imported (commit fa3cad2) must fail: this is the drift we fixed."""
        def at(rev, path):
            return subprocess.run(["git", "show", f"{rev}:{path}"], cwd=ROOT, check=True,
                                  capture_output=True, text=True).stdout
        try:
            sql = at("fa3cad2", "05_DATABASE/core_reference.sql")
            api = yaml.safe_load(at("fa3cad2", "06_API_CONTRACTS/openapi.yaml"))
        except subprocess.CalledProcessError:
            self.skipTest("handoff commit not available (shallow clone)")
        machines, bindings, _, _ = load()
        errs = cc.check(machines, bindings, sql, api)
        joined = "\n".join(errs)
        for needle in ("Payment: SQL payment.state", "Order: SQL has no", "Design: SQL has no",
                       "OpenAPI has no schema PaymentState"):
            self.assertIn(needle, joined)

    def test_sql_state_drift(self):
        machines, bindings, sql, api = load()
        sql = sql.replace("'PARTIAL_REFUND',", "")
        self.assertTrue(any("Payment: SQL" in e for e in cc.check(machines, bindings, sql, api)))

    def test_openapi_enum_order_and_content(self):
        machines, bindings, sql, api = load()
        api = copy.deepcopy(api)
        api["components"]["schemas"]["OrderState"]["enum"].append("SHIPPED")
        self.assertTrue(any("Order: OpenAPI" in e for e in cc.check(machines, bindings, sql, api)))

    def test_free_string_state_is_rejected(self):
        machines, bindings, sql, api = load()
        api = copy.deepcopy(api)
        api["components"]["schemas"]["Payment"]["properties"]["state"] = {"type": "string"}
        self.assertTrue(any("Payment.state" in e for e in cc.check(machines, bindings, sql, api)))

    def test_wrong_sql_default(self):
        machines, bindings, sql, api = load()
        sql = sql.replace("DEFAULT 'PENDING_PAYMENT'", "DEFAULT 'CONFIRMED'")
        self.assertTrue(any("default CONFIRMED" in e for e in cc.check(machines, bindings, sql, api)))

    def test_unreachable_state(self):
        machines, bindings, sql, api = load()
        machines = copy.deepcopy(machines)
        machines["Quote"]["transitions"].append({"from": "LIMBO", "to": "DRAFT", "action": "x"})
        self.assertTrue(any("LIMBO is not reachable" in e for e in cc.check(machines, bindings, sql, api)))

    def test_new_machine_needs_binding(self):
        machines, bindings, sql, api = load()
        machines = {**machines, "Gift": {"initial": "NEW", "transitions": []}}
        self.assertTrue(any("Gift: missing from bindings" in e for e in cc.check(machines, bindings, sql, api)))

    def test_emitted_schemas_match_openapi_text(self):
        machines, bindings, _, _ = load()
        self.assertIn(cc.emit(machines, bindings), cc.OPENAPI.read_text())


def validator(schema_name):
    api = yaml.safe_load(cc.OPENAPI.read_text())
    root = {"$ref": f"#/components/schemas/{schema_name}", "components": api["components"]}
    return Draft202012Validator(root)


RING = {"type": "create_ring", "innerDiameter": 18, "bandWidth": 4, "radialThickness": 1.8, "materialId": "au750"}
SHA = "a" * 64


class OperationAndJobSchemaTest(unittest.TestCase):
    def test_openapi_is_a_valid_3_1_document(self):
        from openapi_spec_validator import validate
        validate(yaml.safe_load(cc.OPENAPI.read_text()))

    def test_operations_match_tools(self):
        api = yaml.safe_load(cc.OPENAPI.read_text())
        tools = json.loads(cc.TOOLS.read_text())
        self.assertEqual(cc.check_operations(tools, api), [])
        self.assertIn(cc.emit_operations(tools), cc.OPENAPI.read_text())

    def test_valid_operation(self):
        validator("DesignOperation").validate(RING)

    def test_invalid_operations_rejected(self):
        v = validator("DesignOperation")
        bad = [
            {**RING, "innerDiameter": 30},                      # outside ring.classic range
            {**RING, "script": "import os"},                     # extra field
            {"type": "run_python", "code": "print(1)"},          # not an allowlisted tool
            {"type": "calculate_volume", "revisionId": "x"},     # READ tool, not an operation
            {k: v for k, v in RING.items() if k != "materialId"},  # missing field
            {"type": "engrave_surface", "componentId": "c", "text": "x" * 81, "depthMm": 0.2},
            {"type": "engrave_surface", "componentId": "c", "text": "AU", "depthMm": 0},
        ]
        for op in bad:
            self.assertFalse(v.is_valid(op), op)

    def test_tool_drift_is_detected(self):
        api = yaml.safe_load(cc.OPENAPI.read_text())
        tools = copy.deepcopy(json.loads(cc.TOOLS.read_text()))
        tools[0]["inputSchema"]["properties"]["innerDiameter"]["maximum"] = 26
        self.assertTrue(cc.check_operations(tools, api))
        tools.append({"name": "new_op", "executionMode": "PREVIEW",
                      "inputSchema": {"properties": {}, "required": []}})
        self.assertTrue(any("variants" in e for e in cc.check_operations(tools, api)))

    def test_create_ring_ranges_follow_families(self):
        tools = json.loads(cc.TOOLS.read_text())
        fams = json.loads(cc.FAMILIES.read_text())
        self.assertEqual(cc.check_create_ring_ranges(tools, fams), [])
        fams = copy.deepcopy(fams)
        next(f for f in fams if f["id"] == "ring.classic")["parameters"]["bandWidth"]["max"] = 10.0
        self.assertTrue(cc.check_create_ring_ranges(tools, fams))

    def test_job_with_artifacts(self):
        v = validator("Job")
        job = {"id": "00000000-0000-0000-0000-000000000001", "kind": "GEOMETRY", "state": "SUCCEEDED",
               "revisionId": "00000000-0000-0000-0000-000000000002", "simulated": False, "errorCode": None,
               "artifacts": [{"id": "00000000-0000-0000-0000-000000000003", "kind": "STEP", "units": "mm",
                              "sha256": SHA, "bytes": 1024}]}
        v.validate(job)
        self.assertFalse(v.is_valid({**job, "artifacts": [{**job["artifacts"][0], "sha256": "ABC"}]}))
        self.assertFalse(v.is_valid({**job, "artifacts": [{**job["artifacts"][0], "url": "https://x"}]}))
        self.assertFalse(v.is_valid({k: x for k, x in job.items() if k != "simulated"}))
        self.assertFalse(v.is_valid({**job, "kind": "SHELL"}))


if __name__ == "__main__":
    unittest.main()
