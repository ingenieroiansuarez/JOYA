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

const CONFIG = {
  env: "ci", port: 0, databaseUrl: "postgresql://x@127.0.0.1:1/x", valkeyUrl: "redis://127.0.0.1:1",
  oidc: { issuer: "http://127.0.0.1:1/realms/test", audience: "aurea-api" },
};
const rejectAll = { verify: async () => { throw new Error("no tokens in this suite"); } };
const fakeProbes = (state) => ({ check: async () => state, close: async () => {} });

// A protected route, built without decorator syntax: without a token it must answer 401.
class Protected { secret() { return { leaked: true }; } }
Get("protected")(Protected.prototype, "secret", Object.getOwnPropertyDescriptor(Protected.prototype, "secret"));
Controller()(Protected);
const { Public } = require("../dist/public.decorator.js");
class Failing { boom() { throw new Error("db password=hunter2 for customer@example.com"); } }
Get("boom")(Failing.prototype, "boom", Object.getOwnPropertyDescriptor(Failing.prototype, "boom"));
Public()(Failing.prototype, "boom", Object.getOwnPropertyDescriptor(Failing.prototype, "boom"));
Controller()(Failing);

async function start(state = { database: "ok", valkey: "ok" }) {
  const app = await createApp(CONFIG, fakeProbes(state), rejectAll, [Protected, Failing]);
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

  test("unhandled errors are logged without PII and do not leak to the client", async () => {
    const logged = [];
    const write = process.stderr.write;
    const writeOut = process.stdout.write;
    process.stderr.write = (chunk, ...rest) => { logged.push(String(chunk)); return true; };
    process.stdout.write = (chunk, ...rest) => { logged.push(String(chunk)); return writeOut.call(process.stdout, chunk, ...rest); };
    let text;
    try {
      const r = await fetch(s.url("/v1/boom"));
      assert.equal(r.status, 500);
      text = await r.text();
    } finally {
      process.stderr.write = write;
      process.stdout.write = writeOut;
    }
    assert.doesNotMatch(text, /hunter2|example\.com/);
    const body = JSON.parse(text);
    assertError(body, "INTERNAL_ERROR", 500);
    const log = logged.join("");
    assert.match(log, new RegExp(`unhandled Error status=500 correlationId=${body.correlationId}`));
    assert.doesNotMatch(log, /hunter2|example\.com/);
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
  const ok = {
    AUREA_ENV: "local", DATABASE_URL: "postgresql://u:p@127.0.0.1/db", VALKEY_URL: "redis://:p@127.0.0.1:6379",
    OIDC_ISSUER: "http://127.0.0.1:8080/realms/aurea-local/", OIDC_AUDIENCE: "aurea-api",
  };
  test("issuer is kept verbatim, trailing slash included", () =>
    assert.equal(loadConfig(ok).oidc.issuer, "http://127.0.0.1:8080/realms/aurea-local/"));
  test("valid local config", () => assert.equal(loadConfig(ok).env, "local"));
  test("demo on the presenter's laptop: loopback http issuer (hito 600)", () =>
    assert.equal(loadConfig({ ...ok, AUREA_ENV: "demo", OIDC_ISSUER: "http://127.0.0.1:8180/realms/aurea-demo" }).env, "demo"));
  for (const [name, env, re] of [
    ["missing database", { ...ok, DATABASE_URL: "" }, /missing configuration: DATABASE_URL/],
    ["unknown environment", { ...ok, AUREA_ENV: "staging" }, /AUREA_ENV must be one of/],
    ["wrong scheme", { ...ok, DATABASE_URL: "mysql://u:p@h/db" }, /DATABASE_URL must use/],
    ["no password in demo", { ...ok, AUREA_ENV: "demo", DATABASE_URL: "postgresql://u@h/db" }, /needs credentials in demo/],
    ["plain valkey in production", { ...ok, AUREA_ENV: "production" }, /must use TLS/],
    ["bad port", { ...ok, API_PORT: "http" }, /API_PORT/],
    ["missing issuer", { ...ok, OIDC_ISSUER: "" }, /missing configuration: OIDC_ISSUER/],
    ["missing audience", { ...ok, OIDC_AUDIENCE: undefined }, /missing configuration: OIDC_AUDIENCE/],
    ["plain http issuer off loopback", { ...ok, OIDC_ISSUER: "http://idp.example/realms/x" }, /OIDC_ISSUER must use https/],
    ["plain http issuer off loopback in demo", { ...ok, AUREA_ENV: "demo", OIDC_ISSUER: "http://192.168.1.20:8180/realms/x" }, /OIDC_ISSUER must use https/],
    ["plain http loopback issuer in production", { ...ok, AUREA_ENV: "production", VALKEY_URL: "rediss://:p@127.0.0.1:6379", OIDC_ISSUER: "http://127.0.0.1:8080/realms/x" }, /OIDC_ISSUER must use https/],
    ["issuer with query", { ...ok, OIDC_ISSUER: "https://idp.example/r?x=1" }, /bare issuer/],
  ]) {
    test(name, () => assert.throws(() => loadConfig(env), (e) => e instanceof ConfigError && re.test(e.message)));
  }
  test("errors name the variable, never its value", () => {
    assert.throws(() => loadConfig({ ...ok, DATABASE_URL: "secretvalue" }), (e) => !e.message.includes("secretvalue"));
  });
});

// Minimal PostgreSQL server: completes the startup handshake, then never answers a query.
async function hungPostgres() {
  const net = await import("node:net");
  const server = net.createServer((sock) => {
    let started = false;
    sock.on("data", () => {
      if (started) return; // swallow every query
      started = true;
      const authOk = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]); // 'R' AuthenticationOk
      const ready = Buffer.from([0x5a, 0, 0, 0, 5, 0x49]); // 'Z' ReadyForQuery (idle)
      sock.write(Buffer.concat([authOk, ready]));
    });
    sock.on("error", () => {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return server;
}

test("a database that hangs on queries is reported down and leaves no open sockets", async () => {
  const server = await hungPostgres();
  const { port } = server.address();
  const probes = createProbes({ ...CONFIG, databaseUrl: `postgresql://u:p@127.0.0.1:${port}/db` });
  try {
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      assert.equal((await probes.check()).database, "down");
      assert.ok(Date.now() - t0 < 4000, "probe exceeded its timeout");
    }
    await new Promise((r) => setTimeout(r, 300));
    const open = await new Promise((r) => server.getConnections((_, n) => r(n)));
    assert.equal(open, 0, "probe connections left open after timeouts");
  } finally {
    await probes.close();
    server.close();
  }
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
