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


def body_validator(op_id):
    api = yaml.safe_load(cc.OPENAPI.read_text())
    _, op = cc._operations(api)[op_id]
    schema = op["requestBody"]["content"]["application/json"]["schema"]
    return Draft202012Validator({**schema, "components": api["components"]})


class TransitionsTest(unittest.TestCase):
    def setUp(self):
        self.machines = json.loads(cc.MACHINES.read_text())
        self.bindings = json.loads(cc.BINDINGS.read_text())
        self.transitions = json.loads(cc.TRANSITIONS.read_text())
        self.api = yaml.safe_load(cc.OPENAPI.read_text())

    def run_check(self, transitions=None, api=None, machines=None):
        return cc.check_transitions(machines or self.machines, self.bindings,
                                    transitions or self.transitions, api or self.api)

    def test_every_action_has_a_trigger(self):
        self.assertEqual(self.run_check(), [])
        self.assertEqual(cc.check_digest_bound(self.api), [])

    def test_missing_action_is_detected(self):
        t = copy.deepcopy(self.transitions)
        del t["Order"]["cancel"]
        self.assertIn("Order.cancel: no trigger in transitions.json", self.run_check(transitions=t))
        m = copy.deepcopy(self.machines)
        m["Order"]["transitions"].append({"from": "READY", "to": "CANCELLED", "action": "abandon"})
        self.assertIn("Order.abandon: no trigger in transitions.json", self.run_check(machines=m))

    def test_bad_entries_are_detected(self):
        t = copy.deepcopy(self.transitions)
        t["Design"]["approve"] = {"via": "api", "operationId": "approveEverything"}
        t["Quote"]["expire"] = {"via": "cron"}
        t["WorkOrder"]["start"] = {"via": "pending"}
        t["Payment"]["confirm"] = {"via": "api", "operationId": "getPayment"}
        errs = "\n".join(self.run_check(transitions=t))
        for needle in ("approveEverything not in OpenAPI", "unknown via 'cron'",
                       "WorkOrder.start: pending without milestone", "getPayment must be POST"):
            self.assertIn(needle, errs)

    def test_response_must_carry_machine_state(self):
        t = copy.deepcopy(self.transitions)
        del t["Quote"]["accept"]["returns"]
        self.assertTrue(any("acceptQuote returns state OrderState" in e for e in self.run_check(transitions=t)))

    def test_idempotency_key_required(self):
        api = copy.deepcopy(self.api)
        op = cc._operations(api)["cancelOrder"][1]
        op["parameters"] = [p for p in op["parameters"] if p.get("name") != "Idempotency-Key"]
        self.assertTrue(any("cancelOrder lacks" in e for e in self.run_check(api=api)))

    def test_digest_binding_is_required(self):
        api = copy.deepcopy(self.api)
        body = cc._operations(api)["rejectQuote"][1]["requestBody"]["content"]["application/json"]["schema"]
        body["required"].remove("expectedDigest")
        self.assertEqual(cc.check_digest_bound(api), ["rejectQuote: requestBody must require expectedDigest"])

    def test_approval_body(self):
        v = body_validator("approveDesign")
        ok = {"expectedDigest": SHA, "dfmReportId": "00000000-0000-0000-0000-000000000001",
              "measurementsConfirmed": True}
        v.validate(ok)
        self.assertFalse(v.is_valid({**ok, "measurementsConfirmed": False}))
        self.assertFalse(v.is_valid({k: x for k, x in ok.items() if k != "dfmReportId"}))
        self.assertFalse(v.is_valid({**ok, "approvedBy": "someone"}))  # identity comes from the token

    def test_reasons_are_mandatory(self):
        for op_id, base in (("returnDesign", {"expectedDigest": SHA}), ("rejectQuote", {"expectedDigest": SHA}),
                            ("cancelOrder", {})):
            v = body_validator(op_id)
            v.validate({**base, "reason": "cliente desiste"})
            self.assertFalse(v.is_valid({**base, "reason": ""}), op_id)
            self.assertFalse(v.is_valid(base), op_id)


class EventEnvelopeTest(unittest.TestCase):
    def setUp(self):
        self.env = json.loads(cc.EVENT.read_text())
        self.api = yaml.safe_load(cc.OPENAPI.read_text())
        self.sql = cc.SQL.read_text()

    def test_one_envelope(self):
        self.assertEqual(cc.check_events(self.env, self.api, self.sql), [])
        self.assertIn(cc.emit_event(self.env), cc.OPENAPI.read_text())

    def test_handoff_v1_envelopes_disagreed(self):
        def at(path):
            return subprocess.run(["git", "show", f"fa3cad2:{path}"], cwd=ROOT, check=True,
                                  capture_output=True, text=True).stdout
        try:
            api, sql = yaml.safe_load(at("06_API_CONTRACTS/openapi.yaml")), at("05_DATABASE/core_reference.sql")
        except subprocess.CalledProcessError:
            self.skipTest("handoff commit not available (shallow clone)")
        errs = "\n".join(cc.check_events(self.env, api, sql))
        for needle in ("OpenAPI Event differs", "outbox lacks column event_type", "outbox lacks column correlation_id"):
            self.assertIn(needle, errs)

    def test_openapi_drift(self):
        api = copy.deepcopy(self.api)
        api["components"]["schemas"]["Event"]["properties"]["version"] = {"type": "integer"}
        self.assertTrue(cc.check_events(self.env, api, self.sql))

    def test_sql_drift(self):
        sql = self.sql.replace("correlation_id uuid NOT NULL, ", "correlation_id uuid, ")
        self.assertIn("SQL outbox.correlation_id: NOT NULL must match envelope required (correlationId)",
                      cc.check_events(self.env, self.api, sql))
        sql = self.sql.replace(", UNIQUE(aggregate_id,aggregate_version)", "")
        self.assertTrue(any("UNIQUE" in e for e in cc.check_events(self.env, self.api, sql)))

    def test_new_envelope_field_needs_column(self):
        env = copy.deepcopy(self.env)
        env["properties"]["tenantId"] = {"type": "string", "format": "uuid"}
        self.assertTrue(any("OUTBOX_COLUMNS" in e for e in cc.check_events(env, self.api, self.sql)))

    def test_envelope_validation(self):
        v = validator("Event")
        ok = {"eventId": "00000000-0000-0000-0000-000000000001", "eventType": "QuoteAccepted", "schemaVersion": 1,
              "aggregateId": "00000000-0000-0000-0000-000000000002", "aggregateVersion": 3,
              "occurredAt": "2026-11-25T10:00:00Z", "correlationId": "00000000-0000-0000-0000-000000000003",
              "causationId": None, "payload": {}}
        v.validate(ok)
        for bad in ({**ok, "eventType": "quote.accepted"}, {**ok, "aggregateVersion": 0},
                    {k: x for k, x in ok.items() if k != "correlationId"}, {**ok, "type": "QuoteAccepted"},
                    {**ok, "payload": []}):
            self.assertFalse(v.is_valid(bad), bad)


class ErrorsTest(unittest.TestCase):
    def setUp(self):
        self.catalog = json.loads(cc.ERRORS.read_text())
        self.api = yaml.safe_load(cc.OPENAPI.read_text())
        self.used = cc.service_error_codes()

    def test_catalog_covers_services(self):
        self.assertIn("SCALE_REQUIRED", self.used)          # mesh, keyword
        self.assertIn("PROVIDER_NOT_CONFIGURED", self.used)  # mesh, class attribute
        self.assertIn("OUT_OF_RANGE", self.used)             # geometry, ValidationIssue
        self.assertEqual(cc.check_errors(self.catalog, self.api, self.used), [])

    def test_unknown_service_code_is_detected(self):
        used = {**self.used, "MESH_ON_FIRE": "services/mesh/aurea_mesh/x.py"}
        self.assertEqual(cc.check_errors(self.catalog, self.api, used),
                         ["services/mesh/aurea_mesh/x.py: error code MESH_ON_FIRE is not in 06_API_CONTRACTS/errors.json"])

    def test_bad_catalog_entries(self):
        cat = copy.deepcopy(self.catalog)
        cat["codes"] += [{"code": "not-snake", "http": 400, "use": "error", "description": ""},
                         {"code": "FORBIDDEN", "http": 403, "use": "error", "description": ""},
                         {"code": "NO_STATUS", "http": None, "use": "error", "description": ""},
                         {"code": "DETAIL_WITH_STATUS", "http": 400, "use": "detail", "description": ""}]
        errs = "\n".join(cc.check_errors(cat, self.api, self.used))
        for needle in ("'not-snake' is not UPPER_SNAKE", "FORBIDDEN repeated", "NO_STATUS needs an HTTP status",
                       "detail code DETAIL_WITH_STATUS"):
            self.assertIn(needle, errs)

    def test_free_details_rejected(self):
        api = copy.deepcopy(self.api)
        api["components"]["schemas"]["Error"]["properties"]["details"] = {"type": "object"}
        self.assertIn("OpenAPI Error.details must be an array of ErrorDetail",
                      cc.check_errors(self.catalog, api, self.used))

    def test_error_validation(self):
        v = validator("Error")
        ok = {"code": "INVALID_DOCUMENT", "message": "El diseño no es válido",
              "correlationId": "00000000-0000-0000-0000-000000000001",
              "details": [{"code": "OUT_OF_RANGE", "pointer": "/components/0/parameters/innerDiameter",
                           "message": "fuera de 14-24 mm"}]}
        v.validate(ok)
        for bad in ({**ok, "code": "invalid document"}, {**ok, "details": {"x": 1}},
                    {**ok, "details": [{"code": "OUT_OF_RANGE", "pointer": "components", "message": "m"}]},
                    {**ok, "details": [{"code": "OUT_OF_RANGE", "message": "m", "stack": "trace"}]}):
            self.assertFalse(v.is_valid(bad), bad)


class SyncTest(unittest.TestCase):
    OP = {"id": "00000000-0000-0000-0000-000000000001", "projectId": "00000000-0000-0000-0000-000000000002",
          "branchId": "00000000-0000-0000-0000-000000000003", "baseRevisionId": "00000000-0000-0000-0000-000000000004",
          "sequence": 1, "createdAt": "2026-11-25T10:00:00Z", "operation": RING}

    def test_operation_is_an_allowlisted_design_operation(self):
        v = validator("SyncOperation")
        v.validate(self.OP)
        for bad in ({**self.OP, "operation": {"type": "run_python", "code": "x"}},
                    {**self.OP, "operation": {**RING, "innerDiameter": 30}},
                    {**self.OP, "payload": {}}, {**self.OP, "sequence": 0},
                    {k: x for k, x in self.OP.items() if k != "baseRevisionId"}):
            self.assertFalse(v.is_valid(bad), bad)

    def test_push_body(self):
        v = body_validator("syncPush")
        v.validate({"deviceId": self.OP["id"], "operations": [self.OP]})
        self.assertFalse(v.is_valid({"deviceId": self.OP["id"], "operations": []}))

    def test_results(self):
        v = validator("SyncResult")
        ok = {"cursor": "c1", "results": [
            {"operationId": self.OP["id"], "status": "APPLIED", "revisionId": self.OP["baseRevisionId"]},
            {"operationId": self.OP["id"], "status": "CONFLICT", "serverRevisionId": self.OP["baseRevisionId"],
             "error": {"code": "VERSION_CONFLICT", "message": "base desactualizada"}},
            {"operationId": self.OP["id"], "status": "REJECTED", "error": {"code": "FORBIDDEN", "message": "sin permiso"}}]}
        v.validate(ok)
        for bad in ({"operationId": self.OP["id"], "status": "APPLIED"},
                    {"operationId": self.OP["id"], "status": "CONFLICT", "error": {"code": "X", "message": "m"}},
                    {"operationId": self.OP["id"], "status": "LAST_WRITE_WINS"}):
            self.assertFalse(v.is_valid({"cursor": "c", "results": [bad]}), bad)


if __name__ == "__main__":
    unittest.main()
