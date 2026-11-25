// Catalog and favorites against a real PostgreSQL (TEST_DATABASE_URL, superuser on a disposable server):
// a scratch database gets the migrations and the synthetic demo seed. Responses are validated against
// the OpenAPI schemas; tokens are signed with a local key (the guard itself is covered by identity.test).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { after, before, describe, test } from "node:test";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import pg from "pg";
import { parse } from "yaml";
import { runMigrations } from "@aurea/db/src/migrate.mjs";
import { DEMO_CATALOG, seedDemo } from "@aurea/db/src/seed-demo.mjs";

const require = createRequire(import.meta.url);
const { createApp } = require("../dist/app.js");
const { createVerifier } = require("../dist/identity/verifier.js");
const { pickLocale } = require("../dist/catalog/catalog.js");

const ROOT = new URL("../../../", import.meta.url);
const api = parse(readFileSync(new URL("06_API_CONTRACTS/openapi.yaml", ROOT), "utf8"), { maxAliasCount: -1 });
const ajv = new Ajv({ strict: false });
addFormats(ajv);
ajv.addSchema({ $id: "openapi", components: api.components });
const schema = (name) => ajv.compile({ $ref: `openapi#/components/schemas/${name}` });
const validPage = schema("ProductPage");
const validProduct = schema("Product");
const validError = schema("Error");
const seed = JSON.parse(readFileSync(DEMO_CATALOG, "utf8")).products;
const published = seed.filter((p) => p.published).sort((a, b) => a.position - b.position);
const draft = seed.find((p) => !p.published);

const ADMIN = process.env.TEST_DATABASE_URL;
const skip = ADMIN ? false : "TEST_DATABASE_URL not set";
const DB = `aurea_t_api_${process.pid}_${Date.now()}`;
const dbUrl = () => { const u = new URL(ADMIN); u.pathname = `/${DB}`; return u.toString(); };
async function admin(sql) {
  const c = new pg.Client({ connectionString: ADMIN });
  await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
}

const ISSUER = "http://127.0.0.1:1/realms/test";
const config = () => ({
  env: "ci", port: 0, databaseUrl: dbUrl(), valkeyUrl: "redis://127.0.0.1:1", oidc: { issuer: ISSUER, audience: "aurea-api" },
});
const probes = { check: async () => ({ database: "ok", valkey: "ok" }), close: async () => {} };
const ALICE = "3c1e9f50-0000-4000-8000-00000000a11c";
const BOB = "3c1e9f50-0000-4000-8000-000000000b0b";

let key, s;
const token = (sub, roles = ["customer"]) => new SignJWT({ realm_access: { roles } })
  .setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(ISSUER).setAudience("aurea-api").setSubject(sub)
  .setIssuedAt().setExpirationTime("5m").sign(key.privateKey);
const call = async (method, path, { sub, roles, lang } = {}) => {
  const headers = {};
  if (sub) headers.authorization = `Bearer ${await token(sub, roles)}`;
  if (lang) headers["accept-language"] = lang;
  return fetch(s.url(path), { method, headers });
};

describe("catalog and favorites", { skip }, () => {
  before(async () => {
    await admin(`CREATE DATABASE ${DB}`);
    await runMigrations(dbUrl());
    await seedDemo(dbUrl(), "ci");
    key = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(key.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    const app = await createApp(config(), probes, await createVerifier(config(), createLocalJWKSet({ keys: [jwk] })));
    await app.listen(0, "127.0.0.1");
    const { port } = app.getHttpServer().address();
    s = { app, url: (p) => `http://127.0.0.1:${port}${p}` };
  });
  after(async () => {
    await s?.app.close();
    await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  });

  test("a guest pages through every published product, in editorial order, without a token", async () => {
    const seen = [];
    let cursor = null;
    do {
      const r = await call("GET", `/v1/catalog/products?limit=3${cursor ? `&cursor=${cursor}` : ""}`);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("content-language"), "es");
      const body = await r.json();
      assert.ok(validPage(body), JSON.stringify(validPage.errors));
      assert.ok(body.items.length <= 3);
      seen.push(...body.items);
      cursor = body.nextCursor;
    } while (cursor);
    assert.deepEqual(seen.map((p) => p.sku), published.map((p) => p.sku));
    assert.ok(!seen.some((p) => p.sku === draft.sku), "drafts never appear");
  });

  test("prices stay exact decimal strings and never include costs", async () => {
    const body = await (await call("GET", "/v1/catalog/products?limit=50")).json();
    const ring = body.items.find((p) => p.sku === "AUR-RNG-001");
    assert.deepEqual(ring.price, { amount: "2850000", currency: "COP" });
    assert.ok(!JSON.stringify(body).match(/cost/i));
  });

  test("category filter and English texts", async () => {
    const r = await call("GET", "/v1/catalog/products?category=RING", { lang: "en-US,en;q=0.9,es;q=0.5" });
    assert.equal(r.headers.get("content-language"), "en");
    const body = await r.json();
    assert.ok(body.items.length > 0 && body.items.every((p) => p.category === "RING"));
    assert.equal(body.items[0].name, "Classic Ring");
  });

  test("detail carries grams and carats explicitly", async () => {
    const emerald = seed.find((p) => p.sku === "AUR-RNG-003");
    const r = await call("GET", `/v1/catalog/products/${emerald.id}`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(validProduct(body), JSON.stringify(validProduct.errors));
    assert.equal(body.metalWeightGrams, "5.100");
    assert.deepEqual(body.stones, [{ type: "EMERALD", count: 1, totalCarats: "0.800", origin: "LAB_GROWN" }]);
    assert.equal(body.collection, "Andina");
  });

  test("an unpublished or unknown product is a 404 either way", async () => {
    for (const id of [draft.id, "00000000-0000-4000-8000-000000000000"]) {
      const r = await call("GET", `/v1/catalog/products/${id}`);
      assert.equal(r.status, 404);
      const body = await r.json();
      assert.ok(validError(body));
      assert.equal(body.code, "NOT_FOUND");
    }
  });

  for (const [what, path] of [
    ["a malformed id", "/v1/catalog/products/not-a-uuid"],
    ["limit 0", "/v1/catalog/products?limit=0"],
    ["limit 51", "/v1/catalog/products?limit=51"],
    ["an unknown category", "/v1/catalog/products?category=WATCH"],
    ["a forged cursor", `/v1/catalog/products?cursor=${Buffer.from('["x","y"]').toString("base64url")}`],
    ["a non-base64 cursor", "/v1/catalog/products?cursor=%27%3B--"],
  ]) {
    test(`${what} is a 400, not a 500`, async () => {
      const r = await call("GET", path);
      assert.equal(r.status, 400);
      assert.equal((await r.json()).code, "VALIDATION_FAILED");
    });
  }

  test("favorites need a customer: guests get 401, roles without the grant 403", async () => {
    assert.equal((await call("GET", "/v1/me/favorites")).status, 401);
    assert.equal((await call("PUT", `/v1/me/favorites/${published[0].id}`)).status, 401);
    assert.equal((await call("GET", "/v1/me/favorites", { sub: ALICE, roles: ["guest"] })).status, 403);
    assert.equal((await call("PUT", `/v1/me/favorites/${published[0].id}`, { sub: ALICE, roles: ["auditor"] })).status, 403);
  });

  test("saving is idempotent, most recent first, and per customer", async () => {
    const [a, b] = [published[1], published[4]];
    for (const p of [a, b, a]) assert.equal((await call("PUT", `/v1/me/favorites/${p.id}`, { sub: ALICE })).status, 204);
    const mine = await (await call("GET", "/v1/me/favorites", { sub: ALICE })).json();
    assert.ok(validPage(mine), JSON.stringify(validPage.errors));
    assert.deepEqual(mine.items.map((p) => p.sku), [b.sku, a.sku]);
    const bobs = await (await call("GET", "/v1/me/favorites", { sub: BOB })).json();
    assert.deepEqual(bobs, { items: [], nextCursor: null }, "another customer sees nothing (scope own)");
    // Bob removing Alice's favorite affects only Bob's (empty) list.
    assert.equal((await call("DELETE", `/v1/me/favorites/${a.id}`, { sub: BOB })).status, 204);
    assert.equal((await (await call("GET", "/v1/me/favorites", { sub: ALICE })).json()).items.length, 2);
  });

  test("removing is idempotent", async () => {
    const p = published[1];
    for (let i = 0; i < 2; i++) assert.equal((await call("DELETE", `/v1/me/favorites/${p.id}`, { sub: ALICE })).status, 204);
    const mine = await (await call("GET", "/v1/me/favorites", { sub: ALICE })).json();
    assert.ok(!mine.items.some((x) => x.id === p.id));
  });

  test("a draft or unknown product cannot be saved", async () => {
    assert.equal((await call("PUT", `/v1/me/favorites/${draft.id}`, { sub: ALICE })).status, 404);
    assert.equal((await call("PUT", "/v1/me/favorites/00000000-0000-4000-8000-000000000000", { sub: ALICE })).status, 404);
  });

  test("concurrent first saves by a new customer do not fail", async () => {
    const carol = "3c1e9f50-0000-4000-8000-0000000ca201";
    const rs = await Promise.all(published.slice(0, 6).map((p) => call("PUT", `/v1/me/favorites/${p.id}`, { sub: carol })));
    assert.deepEqual(rs.map((r) => r.status), Array(6).fill(204));
    const mine = await (await call("GET", "/v1/me/favorites", { sub: carol })).json();
    assert.equal(mine.items.length, 6);
  });

  test("favorites page with a cursor", async () => {
    const dave = "3c1e9f50-0000-4000-8000-00000000da7e";
    for (const p of published) await call("PUT", `/v1/me/favorites/${p.id}`, { sub: dave });
    // 10 published < page size 20: one page, no cursor; a forged cursor is a 400.
    const body = await (await call("GET", "/v1/me/favorites", { sub: dave })).json();
    assert.equal(body.items.length, published.length);
    assert.equal(body.nextCursor, null);
    const bad = Buffer.from(JSON.stringify([1, published[0].id])).toString("base64url");
    assert.equal((await call("GET", `/v1/me/favorites?cursor=${bad}`, { sub: dave })).status, 400);
  });
});

describe("catalog without a database", () => {
  test("an unreachable database is a 503, never a 500 or a fake empty list", async () => {
    const cfg = { env: "ci", port: 0, databaseUrl: "postgresql://x@127.0.0.1:1/x", valkeyUrl: "redis://127.0.0.1:1",
      oidc: { issuer: ISSUER, audience: "aurea-api" } };
    const app = await createApp(cfg, probes, { verify: async () => { throw new Error("unused"); } });
    await app.listen(0, "127.0.0.1");
    const { port } = app.getHttpServer().address();
    try {
      const r = await fetch(`http://127.0.0.1:${port}/v1/catalog/products`);
      assert.equal(r.status, 503);
      assert.equal((await r.json()).code, "SERVICE_UNAVAILABLE");
    } finally {
      await app.close();
    }
  });

  test("Accept-Language picks es or en by weight, es otherwise", () => {
    assert.equal(pickLocale(undefined), "es");
    assert.equal(pickLocale("fr-FR,fr;q=0.9"), "es");
    assert.equal(pickLocale("fr,en;q=0.8,es;q=0.7"), "en");
    assert.equal(pickLocale("en;q=0.2,es-CO"), "es");
    assert.equal(pickLocale("en;q=0"), "es");
  });
});
