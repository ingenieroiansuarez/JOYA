// Needs TEST_DATABASE_URL (superuser on a disposable server). The demo seed is refused outside
// local/ci/demo before touching any database, is idempotent, and keeps money and weights exact.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import pg from "pg";
import { runMigrations } from "../src/migrate.mjs";
import { DEMO_CATALOG, seedDemo, validateCatalog } from "../src/seed-demo.mjs";

const ADMIN = process.env.TEST_DATABASE_URL;
const DB = `aurea_t_seed_${process.pid}_${Date.now()}`;
const url = () => { const u = new URL(ADMIN); u.pathname = `/${DB}`; return u.toString(); };
const skip = ADMIN ? false : "TEST_DATABASE_URL not set";
const doc = JSON.parse(readFileSync(DEMO_CATALOG, "utf8"));

async function query(sql, params) {
  const c = new pg.Client({ connectionString: url() });
  await c.connect();
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}

before(async () => {
  if (skip) return;
  const c = new pg.Client({ connectionString: ADMIN });
  await c.connect();
  await c.query(`CREATE DATABASE ${DB}`);
  await c.end();
  await runMigrations(url());
});

after(async () => {
  if (skip) return;
  const c = new pg.Client({ connectionString: ADMIN });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await c.end();
});

for (const env of ["production", "staging", undefined, ""]) {
  test(`seed refuses AUREA_ENV=${env} without connecting`, async () => {
    // An unreachable URL proves no connection is attempted: the refusal comes first.
    await assert.rejects(seedDemo("postgresql://x@127.0.0.1:1/x", env), /refusing to seed demo data/);
  });
}

test("seed refuses a missing DATABASE_URL", async () => {
  await assert.rejects(seedDemo(undefined, "local"), /DATABASE_URL is not set/);
});

test("catalog file is synthetic and well formed", () => {
  assert.ok(validateCatalog(doc).length >= 10);
  assert.throws(() => validateCatalog({ ...doc, synthetic: false }), /synthetic/);
  const bad = structuredClone(doc);
  bad.products[1].stones[0].totalCarats = 0.25; // a float, not an exact decimal string
  assert.throws(() => validateCatalog(bad), /totalCarats/);
});

test("seed is idempotent and exact", { skip }, async () => {
  await seedDemo(url(), "ci");
  await seedDemo(url(), "ci");
  const [{ n }] = await query("SELECT count(*)::int AS n FROM aurea.product");
  assert.equal(n, doc.products.length);
  const [ring] = await query("SELECT price::text, metal_weight_g::text, published_at FROM aurea.product WHERE sku='AUR-RNG-001'");
  assert.equal(ring.price, "2850000.000000");
  assert.equal(ring.metal_weight_g, "4.200");
  assert.ok(ring.published_at);
  const [draft] = await query("SELECT published_at FROM aurea.product WHERE sku='AUR-RNG-099'");
  assert.equal(draft.published_at, null);
});

test("demo stock is seeded once with its RECEIPT movement and is never reset", { skip }, async () => {
  await seedDemo(url(), "ci");
  const lots = await query("SELECT id, on_hand::text, reserved::text, demo FROM aurea.stock_lot ORDER BY id");
  assert.equal(lots.length, 5);
  assert.ok(lots.every((l) => l.demo && l.reserved === "0.000000"));
  // A stockkeeper's adjustment survives a re-run of the seed.
  const lot = "8b0f6a52-5c1e-5d0a-9a51-0d4c8a5e1001";
  await query("UPDATE aurea.stock_lot SET on_hand = on_hand - 1 WHERE id = $1", [lot]);
  await seedDemo(url(), "ci");
  const [after] = await query("SELECT on_hand::text FROM aurea.stock_lot WHERE id = $1", [lot]);
  assert.equal(after.on_hand, "29.000000");
  const moves = await query("SELECT kind, quantity_delta::text, on_hand_after::text FROM aurea.stock_movement WHERE lot_id = $1", [lot]);
  assert.deepEqual(moves, [{ kind: "RECEIPT", quantity_delta: "30.000000", on_hand_after: "30.000000" }]);
  await assert.rejects(query("UPDATE aurea.stock_movement SET reason = 'x'"), /append-only/);
});
