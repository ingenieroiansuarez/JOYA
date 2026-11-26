import assert from "node:assert/strict";
import { test } from "node:test";
import { logoutQuery } from "../lib/server/logout.ts";

test("panel sign-out ends the IdP session: id_token_hint when we have it", () => {
  const q = logoutQuery("aurea-web", "http://127.0.0.1:3100", "eyJ.a.b");
  assert.equal(q.get("id_token_hint"), "eyJ.a.b");
  assert.equal(q.get("client_id"), "aurea-web");
  assert.equal(q.get("post_logout_redirect_uri"), "http://127.0.0.1:3100/");
  assert.equal(logoutQuery("aurea-web", "http://127.0.0.1:3100").has("id_token_hint"), false);
});
