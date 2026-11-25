// Demo reset (hito 600). The guards run without a database; the full reset needs TEST_DATABASE_URL
// (superuser on a disposable server) and creates its own `aurea_demo` there. If that server already
// has an `aurea_demo`, the test is skipped rather than erasing a database it did not create.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { assertDemoTarget, DEMO_DATABASE, resetDemo } from "../src/reset-demo.mjs";

const ADMIN = process.env.TEST_DATABASE_URL;
const demoUrl = () => { const u = new URL(ADMIN); u.pathname = `/${DEMO_DATABASE}`; return u.toString(); };
let created = false;

async function admin(sql) {
  const c = new pg.Client({ connectionString: ADMIN });
  await c.connect();
  try { return (await c.query(sql)).rows; } finally { await c.end(); }
}
async function demo(sql, params) {
  const c = new pg.Client({ connectionString: demoUrl() });
  await c.connect();
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}

before(async () => {
  if (!ADMIN) return;
  const exists = (await admin(`SELECT 1 FROM pg_database WHERE datname = '${DEMO_DATABASE}'`)).length > 0;
  if (!exists) {
    await admin(`CREATE DATABASE ${DEMO_DATABASE}`);
    created = true;
  }
});
after(async () => {
  if (created) await admin(`DROP DATABASE IF EXISTS ${DEMO_DATABASE} WITH (FORCE)`);
});

for (const [name, url, env, re] of [
  ["local environment", "postgresql://u:p@127.0.0.1:5434/aurea_demo", "local", /only demo/],
  ["production environment", "postgresql://u:p@127.0.0.1:5434/aurea_demo", "production", /only demo/],
  ["no URL", undefined, "demo", /DATABASE_URL is not set/],
  ["the local database", "postgresql://u:p@127.0.0.1:5432/aurea_local", "demo", /only aurea_demo/],
  ["a remote host", "postgresql://u:p@db.example:5432/aurea_demo", "demo", /on db\.example/],
  ["not postgres", "mysql://u:p@127.0.0.1/aurea_demo", "demo", /must be postgresql/],
]) {
  test(`reset refuses ${name} without connecting`, async () => {
    assert.throws(() => assertDemoTarget(url, env), re);
    await assert.rejects(resetDemo(url, env), re);
  });
}

test("errors never echo the password", () => {
  assert.throws(() => assertDemoTarget("postgresql://u:s3cret@db.example/aurea_demo", "demo"), (e) => !e.message.includes("s3cret"));
});

test("reset erases demo activity and reloads the synthetic dataset", async (t) => {
  if (!ADMIN) return t.skip("TEST_DATABASE_URL not set");
  if (!created) return t.skip("aurea_demo already exists on the test server");
  const first = await resetDemo(demoUrl(), "demo");
  assert.ok(first >= 10);
  // Presenter activity: a stock adjustment and a stray row that a fresh dataset does not have.
  await demo("UPDATE aurea.stock_lot SET on_hand = on_hand - 5 WHERE item_key = 'gold-18k-yellow'");
  await demo("INSERT INTO aurea.location(id, name, kind) VALUES (gen_random_uuid(), 'Vitrina temporal', 'STORE')");
  await resetDemo(demoUrl(), "demo");
  const [gold] = await demo("SELECT on_hand::text FROM aurea.stock_lot WHERE item_key = 'gold-18k-yellow'");
  assert.equal(gold.on_hand, "30.000000");
  const locations = await demo("SELECT name FROM aurea.location ORDER BY name");
  assert.deepEqual(locations.map((l) => l.name), ["Taller AUREA (demo)"]);
  const gems = await demo("SELECT item_key, unit, on_hand::text FROM aurea.stock_lot WHERE unit <> 'g' ORDER BY item_key");
  assert.deepEqual(gems.map((g) => g.item_key), ["demo-gem-1", "emerald-lab", "ruby-lab"]);
  assert.ok((await demo("SELECT bool_and(demo) AS d FROM aurea.stock_lot"))[0].d);
});
