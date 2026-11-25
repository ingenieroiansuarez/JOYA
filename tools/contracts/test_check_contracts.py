import copy
import json
import subprocess
import unittest
from pathlib import Path

import yaml

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


if __name__ == "__main__":
    unittest.main()
