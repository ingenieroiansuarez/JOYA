import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { after, before, describe, test } from "node:test";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse } from "yaml";

const require = createRequire(import.meta.url);
const { createApp } = require("../dist/app.js");
const { loadConfig, ConfigError } = require("../dist/config.js");
const { createProbes } = require("../dist/probes.js");
const { Controller, Get } = require("@nestjs/common");

const ROOT = new URL("../../../", import.meta.url);
const api = parse(readFileSync(new URL("06_API_CONTRACTS/openapi.yaml", ROOT), "utf8"), { maxAliasCount: -1 });
const catalog = JSON.parse(readFileSync(new URL("06_API_CONTRACTS/errors.json", ROOT), "utf8"));
const ajv = new Ajv({ strict: false });
addFormats(ajv);
ajv.addSchema({ $id: "openapi", components: api.components });
const validError = ajv.compile({ $ref: "openapi#/components/schemas/Error" });

const CONFIG = { env: "ci", port: 0, databaseUrl: "postgresql://x@127.0.0.1:1/x", valkeyUrl: "redis://127.0.0.1:1" };
const fakeProbes = (state) => ({ check: async () => state, close: async () => {} });

// A protected route, built without decorator syntax: identity is not wired, so it must answer 401.
class Protected { secret() { return { leaked: true }; } }
Get("protected")(Protected.prototype, "secret", Object.getOwnPropertyDescriptor(Protected.prototype, "secret"));
Controller()(Protected);
const { Public } = require("../dist/public.decorator.js");
class Failing { boom() { throw new Error("db password=hunter2 for customer@example.com"); } }
Get("boom")(Failing.prototype, "boom", Object.getOwnPropertyDescriptor(Failing.prototype, "boom"));
Public()(Failing.prototype, "boom", Object.getOwnPropertyDescriptor(Failing.prototype, "boom"));
Controller()(Failing);

async function start(state = { database: "ok", valkey: "ok" }) {
  const app = await createApp(CONFIG, fakeProbes(state), [Protected, Failing]);
  await app.listen(0, "127.0.0.1");
  const { port } = app.getHttpServer().address();
  return { app, url: (p) => `http://127.0.0.1:${port}${p}` };
}

function assertError(body, code, status) {
  assert.ok(validError(body), JSON.stringify(validError.errors));
  assert.equal(body.code, code);
  const entry = catalog.codes.find((c) => c.code === code);
  assert.ok(entry, `${code} not catalogued`);
  assert.equal(entry.http, status);
}

describe("api skeleton", () => {
  let s;
  before(async () => { s = await start(); });
  after(async () => { await s.app.close(); });

  test("liveness is public and outside /v1", async () => {
    const r = await fetch(s.url("/healthz"));
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { status: "ok" });
    assert.equal(r.headers.get("x-powered-by"), null);
  });

  test("readiness reports both dependencies", async () => {
    const r = await fetch(s.url("/readyz"));
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).checks, { database: "ok", valkey: "ok" });
  });

  test("every non-public route is denied by default", async () => {
    const r = await fetch(s.url("/v1/protected"));
    assert.equal(r.status, 401);
    const body = await r.json();
    assertError(body, "UNAUTHENTICATED", 401);
    assert.equal(body.leaked, undefined);
  });

  test("unknown routes answer NOT_FOUND in the contract shape", async () => {
    const r = await fetch(s.url("/v1/nope"));
    assert.equal(r.status, 404);
    assertError(await r.json(), "NOT_FOUND", 404);
  });

  test("unhandled errors do not leak messages", async () => {
    const r = await fetch(s.url("/v1/boom"));
    assert.equal(r.status, 500);
    const text = await r.text();
    assert.doesNotMatch(text, /hunter2|example\.com/);
    assertError(JSON.parse(text), "INTERNAL_ERROR", 500);
  });

  test("correlation id is echoed when it is a UUID and replaced otherwise", async () => {
    const id = "6f1d2a4e-3b5c-4d7e-8f90-1a2b3c4d5e6f";
    const a = await fetch(s.url("/v1/nope"), { headers: { "x-correlation-id": id } });
    assert.equal((await a.json()).correlationId, id);
    assert.equal(a.headers.get("x-correlation-id"), id);
    const b = await fetch(s.url("/v1/nope"), { headers: { "x-correlation-id": "<script>" } });
    assert.notEqual((await b.json()).correlationId, "<script>");
  });
});

test("readiness fails with 503 when a dependency is down", async () => {
  const s = await start({ database: "ok", valkey: "down" });
  try {
    const r = await fetch(s.url("/readyz"));
    assert.equal(r.status, 503);
    assertError(await r.json(), "SERVICE_UNAVAILABLE", 503);
  } finally {
    await s.app.close();
  }
});

describe("configuration fails closed", () => {
  const ok = { AUREA_ENV: "local", DATABASE_URL: "postgresql://u:p@127.0.0.1/db", VALKEY_URL: "redis://:p@127.0.0.1:6379" };
  test("valid local config", () => assert.equal(loadConfig(ok).env, "local"));
  for (const [name, env, re] of [
    ["missing database", { ...ok, DATABASE_URL: "" }, /missing configuration: DATABASE_URL/],
    ["unknown environment", { ...ok, AUREA_ENV: "staging" }, /AUREA_ENV must be one of/],
    ["wrong scheme", { ...ok, DATABASE_URL: "mysql://u:p@h/db" }, /DATABASE_URL must use/],
    ["no password in demo", { ...ok, AUREA_ENV: "demo", DATABASE_URL: "postgresql://u@h/db" }, /needs credentials in demo/],
    ["plain valkey in production", { ...ok, AUREA_ENV: "production" }, /must use TLS/],
    ["bad port", { ...ok, API_PORT: "http" }, /API_PORT/],
  ]) {
    test(name, () => assert.throws(() => loadConfig(env), (e) => e instanceof ConfigError && re.test(e.message)));
  }
  test("errors name the variable, never its value", () => {
    assert.throws(() => loadConfig({ ...ok, DATABASE_URL: "secretvalue" }), (e) => !e.message.includes("secretvalue"));
  });
});

const DB = process.env.TEST_DATABASE_URL;
const VK = process.env.VALKEY_URL;
test("real probes against compose", { skip: DB && VK ? false : "TEST_DATABASE_URL/VALKEY_URL not set" }, async () => {
  const good = createProbes({ ...CONFIG, databaseUrl: DB, valkeyUrl: VK });
  const bad = createProbes({ ...CONFIG, databaseUrl: DB, valkeyUrl: VK.replace(/:[^:@/]+@/, ":wrong@") });
  try {
    assert.deepEqual(await good.check(), { database: "ok", valkey: "ok" });
    assert.equal((await bad.check()).valkey, "down");
  } finally {
    await good.close();
    await bad.close();
  }
});
