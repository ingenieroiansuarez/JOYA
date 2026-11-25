// Needs TEST_DATABASE_URL: a superuser connection to a disposable server (CI compose or local).
// Creates two scratch databases, applies the migrations to one and 05_DATABASE/core_reference.sql
// to the other, and requires the same tables, columns, constraints and indexes.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import pg from "pg";
import { runMigrations } from "../src/migrate.mjs";

const ADMIN = process.env.TEST_DATABASE_URL;
const REFERENCE = new URL("../../../05_DATABASE/core_reference.sql", import.meta.url);
const SUFFIX = `${process.pid}_${Date.now()}`;
const DBS = { migrated: `aurea_t_mig_${SUFFIX}`, reference: `aurea_t_ref_${SUFFIX}` };

const urlFor = (db) => { const u = new URL(ADMIN); u.pathname = `/${db}`; return u.toString(); };

async function admin(sql) {
  const c = new pg.Client({ connectionString: ADMIN });
  await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
}

async function withDb(db, fn) {
  const c = new pg.Client({ connectionString: urlFor(db) });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

const CATALOG = `
  SELECT 'column' AS kind, table_name || '.' || column_name AS name,
         concat_ws(' ', data_type, character_maximum_length, numeric_precision, numeric_scale,
                   is_nullable, column_default) AS def
    FROM information_schema.columns WHERE table_schema = 'aurea'
  UNION ALL
  SELECT 'constraint', conrelid::regclass::text || ':' || conname, pg_get_constraintdef(oid)
    FROM pg_constraint WHERE connamespace = 'aurea'::regnamespace
  UNION ALL
  SELECT 'index', tablename, indexdef FROM pg_indexes WHERE schemaname = 'aurea'
  ORDER BY 1, 2, 3`;

const skip = ADMIN ? false : "TEST_DATABASE_URL not set";

before(async () => {
  if (skip) return;
  for (const db of Object.values(DBS)) await admin(`CREATE DATABASE ${db}`);
});

after(async () => {
  if (skip) return;
  for (const db of Object.values(DBS)) await admin(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
});

test("migrations reproduce core_reference.sql exactly", { skip }, async () => {
  await runMigrations(urlFor(DBS.migrated));
  const sql = await readFile(REFERENCE, "utf8");
  await withDb(DBS.reference, (c) => c.query(sql));
  const [mig, ref] = await Promise.all(
    [DBS.migrated, DBS.reference].map((db) => withDb(db, async (c) => (await c.query(CATALOG)).rows)),
  );
  assert.ok(ref.length > 50, `reference catalog looks empty (${ref.length} rows)`);
  assert.deepEqual(mig, ref);
});

test("migrating twice is a no-op", { skip }, async () => {
  await runMigrations(urlFor(DBS.migrated));
  const n = await withDb(DBS.migrated, async (c) =>
    (await c.query("SELECT count(*)::int AS n FROM aurea_migrations.__drizzle_migrations")).rows[0].n);
  assert.equal(n, 1);
});

test("a missing DATABASE_URL fails closed", async () => {
  await assert.rejects(runMigrations(undefined), /DATABASE_URL is not set/);
});
