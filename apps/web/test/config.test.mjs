import assert from "node:assert/strict";
import { test } from "node:test";
import { WebConfigError, webConfig } from "../lib/server/config.ts";

const base = { OIDC_ISSUER: "http://127.0.0.1:8180/realms/aurea-demo", KC_WEB_CLIENT_SECRET: "x", WEB_SESSION_SECRET: "s".repeat(40) };

test("demo on the presenter's laptop: loopback http origin (hito 600)", () => {
  const c = webConfig({ ...base, AUREA_ENV: "demo", WEB_ORIGIN: "http://127.0.0.1:3101", API_PORT: "3901" });
  assert.equal(c.origin, "http://127.0.0.1:3101");
  assert.equal(c.apiUrl, "http://127.0.0.1:3901/v1");
  assert.equal(c.secureCookies, false);
});

test("demo refuses plain http off loopback; production refuses any http", () => {
  assert.throws(() => webConfig({ ...base, AUREA_ENV: "demo", WEB_ORIGIN: "http://192.168.1.20:3101" }), WebConfigError);
  assert.throws(() => webConfig({ ...base, AUREA_ENV: "demo", WEB_ORIGIN: "http://127.0.0.1.evil.example:3101" }), WebConfigError);
  assert.throws(() => webConfig({ ...base, AUREA_ENV: "production", WEB_ORIGIN: "http://127.0.0.1:3101" }), /https in production/);
});

test("demo and local panels use different cookie names, so on 127.0.0.1 they never sign each other out", () => {
  const demo = webConfig({ ...base, AUREA_ENV: "demo", WEB_ORIGIN: "http://127.0.0.1:3101" });
  const local = webConfig({ ...base, AUREA_ENV: "local", WEB_ORIGIN: "http://127.0.0.1:3100" });
  const prod = webConfig({ ...base, AUREA_ENV: "production", WEB_ORIGIN: "https://panel.example" });
  assert.equal(demo.cookiePrefix, "aurea_demo");
  assert.equal(local.cookiePrefix, "aurea");
  assert.equal(prod.cookiePrefix, "aurea"); // existing sessions keep their cookie
  assert.notEqual(demo.cookiePrefix, local.cookiePrefix);
});
