import assert from "node:assert/strict";
import { test } from "node:test";
import { isStaff } from "../lib/server/staff.ts";

test("the panel is for team roles; a customer's shared IdP session stops at the door", () => {
  assert.equal(isStaff({ roles: ["customer", "default-roles-aurea-local", "offline_access"] }), false);
  assert.equal(isStaff({ roles: ["supplier"] }), false);
  assert.equal(isStaff({ roles: [] }), false);
  assert.equal(isStaff({ roles: ["advisor", "stockkeeper", "finance"] }), true);
  assert.equal(isStaff({ roles: ["customer", "advisor"] }), true);
});
