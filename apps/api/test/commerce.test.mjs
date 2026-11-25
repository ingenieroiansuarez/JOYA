// Hito 500 commercial slice against a real PostgreSQL (TEST_DATABASE_URL) and a fake geometry worker.
// Gate: quote from a fixed revision → issue → accept (order + metal held) → simulated deposit →
// order confirmed; frozen snapshot; duplicate payment; stock concurrency.
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import pg from "pg";
import { parse } from "yaml";
import { runMigrations } from "@aurea/db/src/migrate.mjs";

const require = createRequire(import.meta.url);
const { createApp } = require("../dist/app.js");
const { createVerifier } = require("../dist/identity/verifier.js");
const { loadDesignConfig } = require("../dist/design/config.js");
const { loadCommerceConfig } = require("../dist/commerce/config.js");
const { priceRevision, validateRules } = require("../dist/commerce/pricing.js");
const { dec, div, mul, roundTo, str, ceilPlaces } = require("../dist/commerce/money.js");
const { JobRunner } = require("../dist/design/jobs.js");
const { ArtifactStore } = require("../dist/design/store.js");
const { GeometryWorker } = require("../dist/design/worker-client.js");

const ROOT = new URL("../../../", import.meta.url);
const api = parse(readFileSync(new URL("06_API_CONTRACTS/openapi.yaml", ROOT), "utf8"), { maxAliasCount: -1 });
const ajv = new Ajv({ strict: false });
addFormats(ajv);
ajv.addSchema({ $id: "openapi", components: api.components });
const V = Object.fromEntries(["Quote", "QuotePage", "Order", "OrderPage", "Payment", "InventoryLotPage", "Error"]
  .map((n) => [n, ajv.compile({ $ref: `openapi#/components/schemas/${n}` })]));
const valid = (name, body) => assert.ok(V[name](body), `${name}: ${JSON.stringify(V[name].errors)}\n${JSON.stringify(body).slice(0, 800)}`);

const ADMIN = process.env.TEST_DATABASE_URL;
const skip = ADMIN ? false : "TEST_DATABASE_URL not set";
const DB = `aurea_t_com_${process.pid}_${Date.now()}`;
const dbUrl = () => { const u = new URL(ADMIN); u.pathname = `/${DB}`; return u.toString(); };
async function admin(sql) {
  const c = new pg.Client({ connectionString: ADMIN });
  await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
}

const WORKER_SECRET = "w".repeat(40);
const WEBHOOK_SECRET = "h".repeat(40);
const ISSUER = "http://127.0.0.1:1/realms/test";
const ALICE = "3c1e9f50-0000-4000-8000-0000000a1a1a";
const BOB = "3c1e9f50-0000-4000-8000-0000000b0b0b";
const CAROL = "3c1e9f50-0000-4000-8000-0000000c0c0c"; // advisor
const DAVE = "3c1e9f50-0000-4000-8000-0000000d0d0d"; // finance
const ERIN = "3c1e9f50-0000-4000-8000-0000000e0e0e"; // stockkeeper
const LOC = "8b0f6a52-5c1e-5d0a-9a51-0d4c8a5e0001";

function fakeWorker() {
  return createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const sig = Object.fromEntries((req.headers["x-aurea-signature"] ?? "").split(",").map((kv) => kv.split("=")));
      const mac = createHmac("sha256", WORKER_SECRET).update(Buffer.concat([Buffer.from(`${sig.t}.POST./v1/regenerate.`), body])).digest("hex");
      const send = (status, json) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(json)); };
      if (mac !== sig.v1) return send(401, { code: "UNAUTHENTICATED", details: [] });
      const { document } = JSON.parse(body);
      const c = document.components[0];
      const q = c.parameters;
      const ri = q.innerDiameter / 2, ro = ri + q.radialThickness;
      const vol = Math.PI * (ro * ro - ri * ri) * q.bandWidth;
      const file = (name, kind, units, text) => {
        const data = Buffer.from(text);
        return { name, kind, units, sha256: createHash("sha256").update(data).digest("hex"), bytes: data.length, contentBase64: data.toString("base64") };
      };
      const tag = JSON.stringify(q) + c.materialId;
      send(200, {
        jobId: "x",
        manifest: {
          status: "POC_ONLY_NOT_APPROVED_FOR_MANUFACTURING", engineVersion: "fake/0", kernelVersion: "fake", inputDigest: "0".repeat(64),
          components: [{ id: c.id, family: c.family, materialId: c.materialId, brepVolumeMm3: vol, analyticVolumeMm3: vol, boundingBoxMm: [[-ro, -ro, 0], [ro, ro, q.bandWidth]] }],
          dfm: { state: "REVIEW", humanApprovalRequired: true, findings: [{ rule: "DFM-02", component: c.id, measured: q.radialThickness }] },
        },
        files: [file(`${c.id}.step`, "STEP", "mm", `STEP ${tag}`), file(`${c.id}.stl`, "STL", "mm", `STL ${tag}`),
          file(`${c.id}.glb`, "GLB_PREVIEW", "m", `GLB ${tag}`), file("dfm.json", "DFM_REPORT", "none", "{}"), file("manifest.json", "MANIFEST", "none", "{}")],
      });
    });
  });
}

let key, s, runner, workerServer, artifactDir, pool, commerce;
const ROLES = { [ALICE]: ["customer"], [BOB]: ["customer"], [CAROL]: ["advisor"], [DAVE]: ["finance"], [ERIN]: ["stockkeeper"] };
const token = (sub, roles) => new SignJWT({ realm_access: { roles: roles ?? ROLES[sub] ?? ["customer"] } })
  .setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(ISSUER).setAudience("aurea-api").setSubject(sub)
  .setIssuedAt().setExpirationTime("5m").sign(key.privateKey);
async function call(method, path, { sub = ALICE, roles, body, idem = method === "POST" ? randomUUID() : undefined, lang } = {}) {
  const headers = { "content-type": "application/json" };
  if (sub) headers.authorization = `Bearer ${await token(sub, roles)}`;
  if (idem) headers["idempotency-key"] = idem;
  if (lang) headers["accept-language"] = lang;
  const r = await fetch(s.url(path), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function webhook(event, { secret = WEBHOOK_SECRET, t = Math.floor(Date.now() / 1000), raw } = {}) {
  const body = raw ?? JSON.stringify(event);
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  const r = await fetch(s.url("/v1/payments/webhooks/simulated"), { method: "POST", headers: { "content-type": "application/json", "x-aurea-signature": `t=${t},v1=${v1}` }, body });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function settle(jobId, sub = ALICE) {
  for (let i = 0; i < 400; i++) {
    await runner.drain();
    const job = (await call("GET", `/v1/jobs/${jobId}`, { sub })).body;
    if (!["QUEUED", "RUNNING"].includes(job.state)) return job;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error("job did not settle");
}
/** A project with succeeded geometry for its head revision (the evidence a quote is priced from). */
async function pricedProject(sub = ALICE, materialId = "gold-18k-yellow", params) {
  const p = (await call("POST", "/v1/projects", { sub, body: { title: "Anillo venta", templateId: "ring.classic", materialId } })).body;
  let revisionId = p.headRevisionId;
  if (params) {
    const pv = await call("POST", `/v1/projects/${p.id}/operations`, { sub, body: { baseRevisionId: revisionId, operation: Object.entries(params).map(([name, value]) => ({ type: "modify_parameter", componentId: "ring-base", name, value }))[0] } });
    assert.equal(pv.status, 202, JSON.stringify(pv.body));
    const job = await settle(pv.body.id, sub);
    const rev = await call("POST", `/v1/projects/${p.id}/revisions`, { sub, body: { baseRevisionId: revisionId, previewJobId: job.id, accepted: true } });
    revisionId = rev.body.id;
  }
  const g = await call("POST", "/v1/geometry/jobs", { sub, body: { revisionId, quality: "INTERACTIVE" } });
  assert.equal(g.status, 202, JSON.stringify(g.body));
  assert.equal((await settle(g.body.id, sub)).state, "SUCCEEDED");
  return { ...p, revisionId };
}
const requestQuote = (p, sub = ALICE) => call("POST", "/v1/quotes", { sub, body: { revisionId: p.revisionId, currency: "COP" } });
const inDays = (d) => new Date(Date.now() + d * 86_400_000).toISOString();
async function issue(q, opts = {}) {
  return call("POST", `/v1/quotes/${q.id}/issue`, { sub: CAROL, ...opts, body: { expectedDigest: q.digest, expiresAt: inDays(5), total: q.total, termsVersion: "demo-terms-2026.11", ...opts.body } });
}
async function issuedQuote(sub = ALICE, materialId, params) {
  const p = await pricedProject(sub, materialId, params);
  const q = (await requestQuote(p, sub)).body;
  const i = await issue(q);
  assert.equal(i.status, 200, JSON.stringify(i.body));
  return { p, q: i.body };
}
const accept = (q, sub = ALICE, opts = {}) => call("POST", `/v1/quotes/${q.id}/accept`, { sub, ...opts, body: { expectedDigest: q.digest, termsVersion: q.termsVersion } });
async function lot(itemKey) {
  return (await pool.query("SELECT id, on_hand::text, reserved::text FROM aurea.stock_lot WHERE item_key = $1 ORDER BY created_at LIMIT 1", [itemKey])).rows[0];
}
async function setStock(itemKey, grams) {
  await pool.query("DELETE FROM aurea.stock_lot WHERE item_key = $1 AND NOT EXISTS (SELECT 1 FROM aurea.reservation v WHERE v.lot_id = stock_lot.id)", [itemKey]);
  const id = randomUUID();
  await pool.query("INSERT INTO aurea.stock_lot(id, location_id, item_key, unit, on_hand, label) VALUES ($1,$2,$3,'g',$4,$5)", [id, LOC, itemKey, grams, `${itemKey} test`]);
  await pool.query("INSERT INTO aurea.stock_movement(id, lot_id, quantity_delta, actor, reason, kind, on_hand_after) VALUES ($1,$2,$3,'test','alta de prueba','RECEIPT',$3)", [randomUUID(), id, grams]);
  return id;
}
async function deposit(order, sub = ALICE, opts = {}) {
  return call("POST", "/v1/payment-intents", { sub, ...opts, body: { orderId: order.id, kind: "DEPOSIT", amount: order.deposit.required } });
}

describe("commercial slice (hito 500)", { skip }, () => {
  before(async () => {
    await admin(`CREATE DATABASE ${DB}`);
    await runMigrations(dbUrl());
    key = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(key.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    artifactDir = mkdtempSync(join(tmpdir(), "aurea-com-"));
    workerServer = fakeWorker();
    await new Promise((r) => workerServer.listen(0, "127.0.0.1", r));
    const workerUrl = `http://127.0.0.1:${workerServer.address().port}`;
    const design = loadDesignConfig({ GEOMETRY_WORKER_URL: workerUrl, GEOMETRY_WORKER_SECRET: WORKER_SECRET, FILE_URL_SECRET: "f".repeat(40), ARTIFACT_DIR: artifactDir }, "ci");
    commerce = loadCommerceConfig({ PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET }, "ci");
    const config = { env: "ci", port: 0, databaseUrl: dbUrl(), valkeyUrl: "redis://127.0.0.1:1", oidc: { issuer: ISSUER, audience: "aurea-api" }, design, commerce };
    pool = new pg.Pool({ connectionString: dbUrl() });
    await pool.query("INSERT INTO aurea.location(id, name, kind) VALUES ($1, 'Taller de prueba', 'WORKSHOP')", [LOC]);
    for (const [k, g] of [["gold-18k-yellow", "100"], ["gold-18k-rose", "100"], ["silver-925", "100"]]) await setStock(k, g);
    const app = await createApp(config, { check: async () => ({}), close: async () => {} },
      await createVerifier(config, createLocalJWKSet({ keys: [jwk] })), [], pool);
    await app.listen(0, "127.0.0.1");
    const { port } = app.getHttpServer().address();
    s = { app, url: (p) => `http://127.0.0.1:${port}${p}` };
    runner = new JobRunner(pool, new GeometryWorker(workerUrl, WORKER_SECRET, 30_000), new ArtifactStore(artifactDir), 50);
  });
  after(async () => {
    await s?.app.close();
    workerServer?.close();
    await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    if (artifactDir) rmSync(artifactDir, { recursive: true, force: true });
  });

  test("gate: quote → issue → accept → simulated deposit → order confirmed, metal allocated", async () => {
    const p = await pricedProject();
    const r = await requestQuote(p);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    valid("Quote", r.body);
    const q = r.body;
    assert.equal(q.state, "DRAFT");
    // Independent arithmetic (hand-computed from pricing.demo.json, ring.classic defaults, 15.5 g/cm³):
    // 447.865 mm³ → 6.942 g; metal 6.942 × 1.05 × 310000 = 2259621; cost + 180000 + 60000 + 40000 = 2539621;
    // ÷ 0.60 → 4232700 (to 100); tax 19 % = 804213; total 5036913; deposit 30 % → 1511100.
    assert.deepEqual(q.bom, [{ componentId: "ring-base", materialId: "gold-18k-yellow", massGrams: "6.942", densityStatus: "NOMINAL_UNCONFIRMED" }]);
    assert.deepEqual(q.subtotal, { amount: "4232700", currency: "COP" });
    assert.deepEqual(q.tax.amount, { amount: "804213", currency: "COP" });
    assert.deepEqual(q.total, { amount: "5036913", currency: "COP" });
    assert.deepEqual(q.deposit.amount, { amount: "1511100", currency: "COP" });
    assert.deepEqual(q.lines.map((l) => [l.code, l.label, l.amount.amount]), [["METAL:gold-18k-yellow", "Oro amarillo 18k", "3766000"], ["WORKMANSHIP", "Hechura, acabado y empaque", "466700"]]);
    assert.equal(q.pricing.simulated, true);
    assert.equal(q.internal, undefined, "a customer never sees costs or margin");
    assert.equal((await requestQuote(p)).body.id, q.id, "asking again returns the open quote");

    // The advisor's queue shows the draft with the internal breakdown.
    const queue = await call("GET", "/v1/quotes?state=DRAFT", { sub: CAROL });
    assert.equal(queue.status, 200);
    valid("QuotePage", queue.body);
    const mine = queue.body.items.find((x) => x.id === q.id);
    assert.deepEqual(mine.internal.cost, { amount: "2539621", currency: "COP" });
    assert.equal(mine.internal.margin, "0.40");
    assert.equal((await call("GET", "/v1/quotes", { sub: BOB })).body.items.length, 0, "another customer sees nothing");

    const issued = await issue(q);
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    valid("Quote", issued.body);
    assert.equal(issued.body.state, "ISSUED");
    assert.notEqual(issued.body.digest, q.digest, "issuing binds terms and expiry into the digest");
    assert.equal(issued.body.termsVersion, "demo-terms-2026.11");
    const seen = (await call("GET", `/v1/quotes/${q.id}`)).body;
    assert.equal(seen.state, "ISSUED");
    assert.equal(seen.internal, undefined);

    const yellow = await lot("gold-18k-yellow");
    const acc = await accept(seen);
    assert.equal(acc.status, 200, JSON.stringify(acc.body));
    valid("Order", acc.body);
    const order = acc.body;
    assert.equal(order.state, "PENDING_PAYMENT");
    assert.deepEqual(order.total, { amount: "5036913", currency: "COP" });
    assert.deepEqual(order.deposit.required, { amount: "1511100", currency: "COP" });
    assert.deepEqual(order.reservations.map((v) => [v.itemKey, v.quantity, v.state]), [["gold-18k-yellow", "7.637", "HELD"]]);
    const after1 = await lot("gold-18k-yellow");
    assert.equal(after1.reserved, str(dec(yellow.reserved) + dec("7.637")));
    assert.equal((await call("GET", `/v1/quotes/${q.id}`)).body.orderId, order.id);

    const intent = await deposit(order);
    assert.equal(intent.status, 200, JSON.stringify(intent.body));
    valid("Payment", intent.body);
    assert.equal(intent.body.state, "PENDING");
    assert.deepEqual(intent.body.provider, { id: "simulated", simulated: true });
    const paid = await call("POST", `/v1/payments/${intent.body.id}/simulate`, { body: { outcome: "APPROVE" } });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.state, "CONFIRMED");
    const done = (await call("GET", `/v1/orders/${order.id}`)).body;
    valid("Order", done);
    assert.equal(done.state, "CONFIRMED");
    assert.deepEqual(done.deposit.paid, { amount: "1511100", currency: "COP" });
    assert.deepEqual(done.deposit.outstanding, { amount: "0", currency: "COP" });
    assert.deepEqual(done.balance, { amount: "3525813", currency: "COP" });
    assert.deepEqual(done.reservations.map((v) => v.state), ["ALLOCATED"]);

    // The panel: the advisor sees the order of a quote they issued; finance sees the payment; the stockkeeper the lot.
    const ol = await call("GET", "/v1/orders", { sub: CAROL });
    valid("OrderPage", ol.body);
    assert.ok(ol.body.items.some((o) => o.id === order.id && o.state === "CONFIRMED"));
    assert.equal((await call("GET", `/v1/payments/${intent.body.id}`, { sub: DAVE })).body.state, "CONFIRMED");
    const lots = await call("GET", "/v1/inventory/lots", { sub: ERIN });
    valid("InventoryLotPage", lots.body);
    const yl = lots.body.items.find((l) => l.itemKey === "gold-18k-yellow");
    assert.equal(dec(yl.allocated) >= dec("7.637"), true);
    const events = (await pool.query("SELECT event_type FROM aurea.outbox WHERE aggregate_id = ANY($1::uuid[]) ORDER BY seq", [[q.id, order.id, intent.body.id]])).rows.map((e) => e.event_type);
    assert.deepEqual(events, ["QuoteRequested", "QuoteIssued", "QuoteAccepted", "OrderCreated", "PaymentCreated", "PaymentConfirmed", "OrderConfirmed"]);
  });

  test("snapshot: an issued quote and its order keep their price when rules or the design change", async () => {
    const { p, q } = await issuedQuote();
    const rate = commerce.rules.rates.metalPerGram["gold-18k-yellow"];
    try {
      commerce.rules.rates.metalPerGram["gold-18k-yellow"] = "999999";
      const again = (await call("GET", `/v1/quotes/${q.id}`)).body;
      assert.deepEqual(again.total, q.total);
      assert.equal(again.digest, q.digest);
      // The database refuses to rewrite a frozen quote.
      await assert.rejects(pool.query("UPDATE aurea.quote SET amount = 1 WHERE id = $1", [q.id]), /frozen/);
      await assert.rejects(pool.query("DELETE FROM aurea.quote WHERE id = $1", [q.id]), /cannot be deleted/);
      const order = (await accept(q)).body;
      assert.deepEqual(order.total, q.total, "the order copies the frozen total, not today's price");
      // A newer revision of the same design gets a new price; the order does not move.
      const p2 = await pricedProject(ALICE, "gold-18k-yellow", { bandWidth: 5 });
      const fresh = (await requestQuote(p2)).body;
      assert.notDeepEqual(fresh.total, q.total);
      assert.equal(fresh.lines[0].amount.amount.length > 7, true, "the new quote uses the changed rate");
      assert.deepEqual((await call("GET", `/v1/orders/${order.id}`)).body.total, q.total);
      assert.ok(p.id);
    } finally {
      commerce.rules.rates.metalPerGram["gold-18k-yellow"] = rate;
    }
  });

  test("snapshot: a draft re-priced since the advisor looked is not issued (PRICE_CHANGED)", async () => {
    const p = await pricedProject(ALICE, "silver-925");
    const q = (await requestQuote(p)).body;
    const rate = commerce.rules.rates.metalPerGram["silver-925"];
    try {
      commerce.rules.rates.metalPerGram["silver-925"] = "6000";
      const r = await issue(q);
      assert.equal(r.status, 409);
      assert.equal(r.body.code, "PRICE_CHANGED");
      const repriced = (await call("GET", `/v1/quotes/${q.id}`, { sub: CAROL })).body;
      assert.equal(repriced.state, "DRAFT");
      assert.notEqual(repriced.digest, q.digest);
      assert.equal((await issue(repriced)).status, 200, "issuing the reviewed new price works");
    } finally {
      commerce.rules.rates.metalPerGram["silver-925"] = rate;
    }
  });

  test("acceptance binds the exact issued version, the owner and the expiry", async () => {
    const { q } = await issuedQuote();
    assert.equal((await accept({ ...q, digest: "0".repeat(64) })).body.code, "DIGEST_MISMATCH");
    assert.equal((await accept({ ...q, termsVersion: "other" })).body.code, "DIGEST_MISMATCH");
    assert.equal((await accept(q, BOB)).status, 404, "another customer cannot accept it");
    assert.equal((await accept(q, CAROL)).status, 403, "staff cannot accept for the customer");
    await pool.query("ALTER TABLE aurea.quote DISABLE TRIGGER quote_frozen");
    await pool.query("UPDATE aurea.quote SET expires_at = now() - interval '1 minute' WHERE id = $1", [q.id]);
    await pool.query("ALTER TABLE aurea.quote ENABLE TRIGGER quote_frozen");
    assert.equal((await call("GET", `/v1/quotes/${q.id}`)).body.state, "EXPIRED");
    const late = await accept(q);
    assert.equal(late.status, 409);
    assert.equal(late.body.code, "QUOTE_EXPIRED");
    assert.equal((await pool.query("SELECT state FROM aurea.quote WHERE id = $1", [q.id])).rows[0].state, "EXPIRED");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM aurea.sales_order WHERE quote_id = $1", [q.id])).rows[0].n, 0);
  });

  test("asking again for a revision whose offer lapsed closes it and gives a fresh draft", async () => {
    const { p, q } = await issuedQuote();
    await pool.query("ALTER TABLE aurea.quote DISABLE TRIGGER quote_frozen");
    await pool.query("UPDATE aurea.quote SET expires_at = now() - interval '1 minute' WHERE id = $1", [q.id]);
    await pool.query("ALTER TABLE aurea.quote ENABLE TRIGGER quote_frozen");
    const again = await requestQuote(p);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.notEqual(again.body.id, q.id);
    assert.equal(again.body.state, "DRAFT");
    assert.equal((await pool.query("SELECT state FROM aurea.quote WHERE id = $1", [q.id])).rows[0].state, "EXPIRED");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM aurea.outbox WHERE event_type = 'QuoteExpired' AND aggregate_id = $1", [q.id])).rows[0].n, 1);
    assert.equal((await requestQuote(p)).body.id, again.body.id, "the new draft is the open one now");
  });

  test("asking again for a revision already sold returns that quote and its order; after a cancel it prices again", async () => {
    const { p, q } = await issuedQuote(ALICE, "silver-925", { bandWidth: 5 });
    const order = (await accept(q)).body;
    const again = await requestQuote(p);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual([again.body.id, again.body.state, again.body.orderId], [q.id, "ACCEPTED", order.id]);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM aurea.quote WHERE revision_id = $1", [p.revisionId])).rows[0].n, 1);
    assert.equal((await call("POST", `/v1/orders/${order.id}/cancel`, { body: { reason: "prueba" } })).status, 200);
    const fresh = await requestQuote(p);
    assert.notEqual(fresh.body.id, q.id);
    assert.equal(fresh.body.state, "DRAFT");
  });

  test("issuing: validated, segregated, needs geometry, supersedes the previous offer", async () => {
    const p = (await call("POST", "/v1/projects", { body: { title: "Sin geometría", templateId: "ring.classic", materialId: "gold-18k-yellow" } })).body;
    const noGeo = await call("POST", "/v1/quotes", { body: { revisionId: p.headRevisionId, currency: "COP" } });
    assert.equal(noGeo.status, 422);
    assert.equal(noGeo.body.code, "GEOMETRY_REQUIRED");
    assert.equal((await call("POST", "/v1/quotes", { body: { revisionId: p.headRevisionId, currency: "USD" } })).status, 400);
    assert.equal((await call("POST", "/v1/quotes", { roles: ["guest"], body: { revisionId: p.headRevisionId, currency: "COP" } })).status, 403);

    const a = await pricedProject();
    const qa = (await requestQuote(a)).body;
    assert.equal((await issue(qa, { sub: ALICE })).status, 403, "customers cannot issue");
    assert.equal((await issue(qa, { body: { total: { amount: "1", currency: "COP" } } })).body.code, "DIGEST_MISMATCH");
    assert.equal((await issue(qa, { body: { expiresAt: inDays(30) } })).status, 400, "beyond the validity policy");
    assert.equal((await issue(qa, { body: { termsVersion: "x" } })).status, 400);
    const both = await issue(qa, { roles: ["advisor", "customer"], sub: ALICE });
    assert.equal(both.status, 403);
    assert.equal(both.body.code, "SEGREGATION_REQUIRED", "the requester cannot issue their own quote");
    const first = (await issue(qa)).body;
    // A newer revision's issued quote supersedes the older offer of the same project.
    const op = await call("POST", `/v1/projects/${a.id}/operations`, { body: { baseRevisionId: a.revisionId, operation: { type: "modify_parameter", componentId: "ring-base", name: "bandWidth", value: 4.5 } } });
    const job = await settle(op.body.id);
    const rev2 = (await call("POST", `/v1/projects/${a.id}/revisions`, { body: { baseRevisionId: a.revisionId, previewJobId: job.id, accepted: true } })).body;
    const q2 = (await call("POST", "/v1/quotes", { body: { revisionId: rev2.id, currency: "COP" } })).body;
    assert.equal(q2.state, "DRAFT", "a preview job of the same design is valid geometry evidence");
    assert.equal((await issue(q2)).status, 200);
    assert.equal((await call("GET", `/v1/quotes/${first.id}`)).body.state, "SUPERSEDED");
    assert.equal((await accept(first)).body.code, "INVALID_TRANSITION");
  });

  test("duplicate payment: same key replays, a second intent is refused, a replayed event changes nothing", async () => {
    const { q } = await issuedQuote(ALICE, "gold-18k-rose");
    const order = (await accept(q)).body;
    assert.equal((await call("POST", "/v1/payment-intents", { body: { orderId: order.id, kind: "DEPOSIT", amount: { amount: "1", currency: "COP" } } })).body.code, "AMOUNT_MISMATCH");
    const key = randomUUID();
    const a = await deposit(order, ALICE, { idem: key });
    const b = await deposit(order, ALICE, { idem: key });
    assert.equal(a.status, 200);
    assert.deepEqual(b.body, a.body, "same Idempotency-Key → same payment");
    const c = await deposit(order);
    assert.equal(c.status, 409);
    assert.equal(c.body.code, "PAYMENT_IN_PROGRESS");
    assert.equal((await deposit(order, BOB)).status, 404);

    const providerId = (await pool.query("SELECT provider_id FROM aurea.payment WHERE id = $1", [a.body.id])).rows[0].provider_id;
    const ev = { eventId: `evt_${randomUUID().replace(/-/g, "")}`, type: "payment.succeeded", providerPaymentId: providerId, amount: order.deposit.required };
    assert.equal((await webhook(ev, { secret: "x".repeat(40) })).status, 401, "bad signature");
    assert.equal((await webhook(ev, { t: Math.floor(Date.now() / 1000) - 3600 })).status, 401, "stale timestamp");
    const w1 = await webhook(ev);
    assert.equal(w1.status, 200, JSON.stringify(w1.body));
    assert.equal(w1.body.outcome, "APPLIED");
    const w2 = await webhook(ev);
    assert.equal(w2.body.outcome, "DUPLICATE");
    const w3 = await webhook({ ...ev, eventId: `evt_${randomUUID().replace(/-/g, "")}` });
    assert.equal(w3.body.outcome, "IGNORED", "a second success for a confirmed payment is ignored");
    const o = (await call("GET", `/v1/orders/${order.id}`)).body;
    assert.equal(o.state, "CONFIRMED");
    assert.equal(o.payments.length, 1);
    assert.deepEqual(o.deposit.paid, order.deposit.required, "paid once");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM aurea.outbox WHERE event_type = 'PaymentConfirmed' AND aggregate_id = $1", [a.body.id])).rows[0].n, 1);
    const again = await deposit(order);
    assert.equal(again.status, 409, "no deposit on a confirmed order");
    await assert.rejects(pool.query("UPDATE aurea.payment_event SET outcome = 'IGNORED'"), /append-only/);
  });

  test("duplicate payment: concurrent intents with different keys create exactly one", async () => {
    const { q } = await issuedQuote(ALICE, "silver-925");
    const order = (await accept(q)).body;
    const rs = await Promise.all(Array.from({ length: 6 }, () => deposit(order)));
    assert.equal(rs.filter((r) => r.status === 200).length, 1, JSON.stringify(rs.map((r) => [r.status, r.body?.code])));
    assert.ok(rs.filter((r) => r.status !== 200).every((r) => r.status === 409));
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM aurea.payment WHERE order_id = $1", [order.id])).rows[0].n, 1);
  });

  test("payments: wrong amount goes to review, a decline can be retried, late success after cancel is not re-opened", async () => {
    const { q } = await issuedQuote(ALICE, "silver-925", { bandWidth: 6 });
    const order = (await accept(q)).body;
    const pay = (await deposit(order)).body;
    const providerId = (await pool.query("SELECT provider_id FROM aurea.payment WHERE id = $1", [pay.id])).rows[0].provider_id;
    const wrong = await webhook({ eventId: `evt_${randomUUID().replace(/-/g, "")}`, type: "payment.succeeded", providerPaymentId: providerId, amount: { amount: "1", currency: "COP" } });
    assert.equal(wrong.body.outcome, "REVIEW");
    const p1 = (await call("GET", `/v1/payments/${pay.id}`)).body;
    assert.equal(p1.state, "PENDING");
    assert.equal(p1.reviewReason, "AMOUNT_MISMATCH");
    assert.equal((await call("GET", `/v1/orders/${order.id}`)).body.state, "PENDING_PAYMENT");
    const right = await webhook({ eventId: `evt_${randomUUID().replace(/-/g, "")}`, type: "payment.succeeded", providerPaymentId: providerId, amount: order.deposit.required });
    assert.equal(right.body.outcome, "REVIEW", "a correct amount after a mismatch does not settle it without reconciliation");
    const p2 = (await call("GET", `/v1/payments/${pay.id}`)).body;
    assert.deepEqual([p2.state, p2.reviewReason], ["PENDING", "AMOUNT_MISMATCH"]);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM aurea.outbox WHERE event_type = 'PaymentConfirmed' AND aggregate_id = $1", [pay.id])).rows[0].n, 0);

    const declined = await call("POST", `/v1/payments/${pay.id}/simulate`, { body: { outcome: "DECLINE" } });
    assert.equal(declined.body.state, "FAILED");
    assert.equal(declined.body.failureCode, "SIMULATED_DECLINE");
    const retry = await deposit(order);
    assert.equal(retry.status, 200, "after a failure a new deposit can be attempted");

    const cancel = await call("POST", `/v1/orders/${order.id}/cancel`, { body: { reason: "Cambié de idea" } });
    assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
    assert.equal(cancel.body.state, "CANCELLED");
    assert.ok(cancel.body.reservations.every((v) => v.state === "RELEASED"));
    const pid = (await pool.query("SELECT provider_id FROM aurea.payment WHERE id = $1", [retry.body.id])).rows[0].provider_id;
    const lateOk = await webhook({ eventId: `evt_${randomUUID().replace(/-/g, "")}`, type: "payment.succeeded", providerPaymentId: pid, amount: order.deposit.required });
    assert.equal(lateOk.body.outcome, "REVIEW");
    const lp = (await call("GET", `/v1/payments/${retry.body.id}`)).body;
    assert.deepEqual([lp.state, lp.reviewReason], ["CONFIRMED", "ORDER_CANCELLED"]);
    assert.equal((await call("GET", `/v1/orders/${order.id}`)).body.state, "CANCELLED", "money arriving late never re-opens the order");
    assert.equal((await call("POST", `/v1/orders/${order.id}/cancel`, { body: { reason: "otra vez" } })).status, 409);
  });

  test("stock: concurrent acceptances never oversell; the losers change nothing; a receipt unblocks", async () => {
    const grams = "16.000"; // two rings of 7.637 g fit, a third does not
    await setStock("platinum-950", grams);
    const quotes = [];
    for (let i = 0; i < 3; i++) quotes.push((await issuedQuote(ALICE, "platinum-950")).q);
    const need = quotes[0].bom[0].massGrams;
    assert.ok(need);
    const rs = await Promise.all(quotes.map((q) => accept(q)));
    const ok = rs.filter((r) => r.status === 200);
    const no = rs.filter((r) => r.status !== 200);
    // Platinum is denser: compute how many fit from the reservation the winners got.
    const per = dec(ok[0].body.reservations[0].quantity);
    const fits = Number(dec(grams) / per);
    assert.equal(ok.length, fits, JSON.stringify(rs.map((r) => [r.status, r.body?.code])));
    assert.ok(no.every((r) => r.status === 409 && r.body.code === "INSUFFICIENT_STOCK"));
    const l = await lot("platinum-950");
    assert.ok(dec(l.reserved) <= dec(l.on_hand));
    assert.equal(l.reserved, str(per * BigInt(fits)));
    const loser = quotes[rs.findIndex((r) => r.status !== 200)];
    assert.equal((await call("GET", `/v1/quotes/${loser.id}`)).body.state, "ISSUED", "a refused acceptance leaves the quote as it was");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM aurea.sales_order WHERE quote_id = $1", [loser.id])).rows[0].n, 0);

    // The stockkeeper receives metal (append-only ledger) and the customer can accept.
    assert.equal((await call("POST", "/v1/inventory/movements", { sub: ALICE, body: { lotId: l.id, kind: "RECEIPT", delta: "10", reason: "x" } })).status, 403);
    const below = await call("POST", "/v1/inventory/movements", { sub: ERIN, body: { lotId: l.id, kind: "ADJUSTMENT", delta: `-${grams}`, reason: "merma" } });
    assert.equal(below.body.code, "INSUFFICIENT_STOCK", "on hand never below reserved");
    const rec = await call("POST", "/v1/inventory/movements", { sub: ERIN, body: { lotId: l.id, kind: "RECEIPT", delta: "10", reason: "Compra de prueba" } });
    assert.equal(rec.status, 200, JSON.stringify(rec.body));
    assert.equal((await accept(loser)).status, 200);
    const moves = (await pool.query("SELECT kind, quantity_delta::text FROM aurea.stock_movement WHERE lot_id = $1 ORDER BY recorded_at", [l.id])).rows;
    assert.deepEqual(moves.map((m) => m.kind), ["RECEIPT", "RECEIPT"]);
    await assert.rejects(pool.query("DELETE FROM aurea.stock_movement WHERE lot_id = $1", [l.id]), /append-only/);
    await assert.rejects(pool.query("UPDATE aurea.stock_lot SET reserved = on_hand + 1 WHERE id = $1", [l.id]), /check/);
  });

  test("stock: an expired hold is released under the lot lock and re-taken when the deposit arrives", async () => {
    await setStock("gold-18k-white", "8");
    const { q } = await issuedQuote(ALICE, "gold-18k-white");
    const order = (await accept(q)).body;
    await pool.query("UPDATE aurea.reservation SET expires_at = now() - interval '1 minute' WHERE order_id = $1", [order.id]);
    const lots = (await call("GET", "/v1/inventory/lots?itemKey=gold-18k-white", { sub: ERIN })).body.items;
    assert.equal(lots[0].reserved, "0", "listing sweeps the expired hold");
    assert.equal((await call("GET", `/v1/orders/${order.id}`)).body.reservations[0].state, "RELEASED");
    const pay = (await deposit(order)).body;
    const done = await call("POST", `/v1/payments/${pay.id}/simulate`, { body: { outcome: "APPROVE" } });
    assert.equal(done.body.state, "CONFIRMED");
    const o = (await call("GET", `/v1/orders/${order.id}`)).body;
    assert.equal(o.state, "CONFIRMED");
    assert.deepEqual(o.reservations.map((v) => v.state).sort(), ["ALLOCATED", "RELEASED"]);
  });

  test("stock: if the metal of an expired hold was sold meanwhile, the deposit waits for a person", async () => {
    await setStock("gold-18k-white", "8");
    const first = (await issuedQuote(ALICE, "gold-18k-white")).q;
    const second = (await issuedQuote(ALICE, "gold-18k-white")).q;
    const o1 = (await accept(first)).body;
    await pool.query("UPDATE aurea.reservation SET expires_at = now() - interval '1 minute' WHERE order_id = $1", [o1.id]);
    assert.equal((await accept(second)).status, 200, "the expired hold is swept and the metal goes to the next order");
    const pay = (await deposit(o1)).body;
    const r = (await call("POST", `/v1/payments/${pay.id}/simulate`, { body: { outcome: "APPROVE" } })).body;
    assert.deepEqual([r.state, r.reviewReason], ["CONFIRMED", "STOCK_UNAVAILABLE"]);
    const o = (await call("GET", `/v1/orders/${o1.id}`)).body;
    assert.equal(o.state, "PENDING_PAYMENT", "no confirmation without metal; a person reconciles");
    assert.deepEqual(o.deposit.paid, { amount: "0", currency: "COP" });
  });

  test("permissions and fail-closed configuration", async () => {
    const { q } = await issuedQuote();
    assert.equal((await call("GET", `/v1/quotes/${q.id}`, { sub: BOB })).status, 404);
    assert.equal((await call("GET", "/v1/inventory/lots")).status, 403, "customers do not read stock");
    assert.equal((await call("GET", "/v1/orders", { roles: ["guest"] })).status, 403);
    assert.equal((await webhook({}, { raw: "not json" })).status, 400);
    const r = await fetch(s.url("/v1/payments/webhooks/stripe"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 404, "no real provider exists");
    assert.throws(() => loadCommerceConfig({ PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET }, "production"), /APPROVED pricing rules/);
    const dir = mkdtempSync(join(tmpdir(), "aurea-rules-"));
    const approved = { ...JSON.parse(readFileSync(new URL("15_COMMERCE_AND_PAYMENTS/pricing.demo.json", ROOT), "utf8")), status: "APPROVED" };
    writeFileSync(join(dir, "r.json"), JSON.stringify(approved));
    assert.throws(() => loadCommerceConfig({ PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET, PRICING_RULES_FILE: join(dir, "r.json") }, "production"), /PAYMENT_PROVIDER is required/);
    assert.throws(() => loadCommerceConfig({ PAYMENT_PROVIDER: "simulated", PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET, PRICING_RULES_FILE: join(dir, "r.json") }, "production"), /not allowed in production/);
    assert.throws(() => loadCommerceConfig({ PAYMENT_PROVIDER: "wompi", PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET }, "local"), /not available/);
    assert.throws(() => loadCommerceConfig({}, "local"), /PAYMENT_WEBHOOK_SECRET/);
    writeFileSync(join(dir, "bad.json"), JSON.stringify({ ...approved, margin: "1.2" }));
    assert.throws(() => loadCommerceConfig({ PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET, PRICING_RULES_FILE: join(dir, "bad.json") }, "local"), /invalid margin/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("pricing arithmetic (pure)", () => {
  const rules = validateRules(JSON.parse(readFileSync(new URL("15_COMMERCE_AND_PAYMENTS/pricing.demo.json", ROOT), "utf8")));
  const doc = { components: [{ id: "ring", family: "ring.classic", materialId: "gold-18k-yellow", parameters: {} }] };
  const geo = (mass) => ({ jobId: randomUUID(), engineVersion: "x", dfmState: "REVIEW", components: [{ id: "ring", family: "ring.classic", materialId: "gold-18k-yellow", massGramsEstimate: mass, densityStatus: "NOMINAL_UNCONFIRMED" }] });
  const rev = { id: randomUUID(), number: 1, digest: "a".repeat(64), document: doc };

  test("price = cost / (1 − margin), lines add up to the subtotal, total = subtotal + tax", () => {
    for (const mass of ["0.001", "1", "6.942", "13.37", "250.5"]) {
      const sn = priceRevision(rules, rev, geo(mass));
      const lines = sn.lines.reduce((a, l) => a + dec(l.amount), 0n);
      assert.equal(lines, dec(sn.subtotal), mass);
      assert.equal(dec(sn.total), dec(sn.subtotal) + dec(sn.tax.amount));
      assert.equal(dec(sn.subtotal), roundTo(div(dec(sn.internal.cost), dec("0.6")), dec("100")));
      assert.ok(dec(sn.subtotal) > dec(sn.internal.cost) * 1n, "never sells below cost");
      assert.equal(dec(sn.subtotal) % dec("100"), 0n);
      assert.equal(sn.bom[0].reserveGrams, str(ceilPlaces(mul(dec(mass), dec("1.1")), 3), 3));
    }
  });
  test("deterministic: same inputs, same snapshot; unknown material or family is refused", () => {
    const g = geo("6.942");
    assert.deepEqual(priceRevision(rules, rev, g), priceRevision(rules, rev, g));
    assert.throws(() => priceRevision(rules, { ...rev, document: { components: [{ ...doc.components[0], family: "ring.99" }] } }, { ...g, components: [{ ...g.components[0], family: "ring.99" }] }), /UNPRICED_FAMILY/);
    assert.throws(() => priceRevision(rules, rev, { ...g, components: [{ ...g.components[0], materialId: "silver-925" }] }), /GEOMETRY_MISMATCH/);
  });
});
