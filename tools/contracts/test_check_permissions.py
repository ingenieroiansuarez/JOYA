import copy
import unittest

import check_permissions as cp


class PermissionsTest(unittest.TestCase):
    def setUp(self):
        self.roles, self.api, self.tools, self.screens, self.csv = cp.load()

    def run_check(self, roles=None, screens=None, csv_rows=None, api=None):
        return cp.check(roles or self.roles, api or self.api, self.tools,
                        screens or self.screens, csv_rows or self.csv)

    def test_current_permissions_are_consistent(self):
        self.assertEqual(self.run_check(), [])

    def test_ungranted_api_permission(self):
        roles = copy.deepcopy(self.roles)
        for r in ("guest", "customer"):
            roles["roles"][r].remove("cart.edit")
            del roles["scopes"][r]["cart.edit"]
        self.assertTrue(any("createCart" in e for e in self.run_check(roles=roles)))

    def test_signed_webhook_needs_no_permission_but_only_when_unauthenticated_and_signed(self):
        api = copy.deepcopy(self.api)
        op = api["paths"]["/payments/webhooks/{provider}"]["post"]
        self.assertEqual(self.run_check(api=api), [])
        del op["x-signature"]
        self.assertTrue(any("receivePaymentWebhook: no x-permission" in e for e in self.run_check(api=api)))

    def test_role_enum_follows_roles(self):
        api = copy.deepcopy(self.api)
        api["components"]["schemas"]["Role"]["enum"].append("superuser")
        self.assertTrue(any("OpenAPI Role enum" in e for e in self.run_check(api=api)))

    def test_grant_without_scope(self):
        roles = copy.deepcopy(self.roles)
        del roles["scopes"]["finance"]["payment.refund"]
        self.assertTrue(any("payment.refund has no scope" in e for e in self.run_check(roles=roles)))

    def test_unknown_scope_and_wildcard(self):
        roles = copy.deepcopy(self.roles)
        roles["scopes"]["finance"]["payment.refund"] = "everything"
        roles["roles"]["admin"].append("identity.*")
        roles["scopes"]["admin"]["identity.*"] = "organization"
        errs = self.run_check(roles=roles)
        self.assertTrue(any("unknown scope" in e for e in errs))
        self.assertTrue(any("wildcard" in e for e in errs))

    def test_default_must_deny(self):
        roles = {**self.roles, "default": "ALLOW"}
        self.assertTrue(any("DENY" in e for e in self.run_check(roles=roles)))

    def test_screen_permission_missing_in_role(self):
        screens = copy.deepcopy(self.screens)
        s = next(x for x in screens if x["id"] == "CAD-LIBRARY-001")
        s["permission"] = "catalog.write"
        self.assertTrue(any("CAD-LIBRARY-001" in e for e in self.run_check(screens=screens)))

    def test_csv_json_disagreement(self):
        rows = copy.deepcopy(self.csv)
        rows[0]["role"] = "admin"
        self.assertTrue(any("disagree" in e for e in self.run_check(csv_rows=rows)))

    def test_author_cannot_publish_library(self):
        roles = copy.deepcopy(self.roles)
        roles["roles"]["designer"].append("library.publish")
        roles["scopes"]["designer"]["library.publish"] = "organization"
        self.assertTrue(any("holds both" in e for e in self.run_check(roles=roles)))


if __name__ == "__main__":
    unittest.main()
