// Resets the isolated demo database (hito 600): drops the AUREA schemas, applies the migrations
// and loads the synthetic catalog and stock again. Authorized reset only (29_DEMO_SCENARIO): it
// refuses unless AUREA_ENV=demo, the database is the demo stack's `aurea_demo` on loopback, and the
// caller passed --yes. Nothing outside that database is touched; credentials are never logged.
import { fileURLToPath } from "node:url";
import pg from "pg";
import { redact, runMigrations } from "./migrate.mjs";
import { seedDemo } from "./seed-demo.mjs";

export const DEMO_DATABASE = "aurea_demo";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Throws, naming the reason, unless `url` is the demo database. Never echoes the URL's password. */
export function assertDemoTarget(url, env) {
  if (env !== "demo") throw new Error(`refusing to reset with AUREA_ENV=${env ?? "<unset>"} (only demo)`);
  if (!url) throw new Error("DATABASE_URL is not set; refusing to guess a database");
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error("DATABASE_URL is not a URL");
  }
  if (!["postgres:", "postgresql:"].includes(u.protocol)) throw new Error("DATABASE_URL must be postgresql");
  if (!LOOPBACK.has(u.hostname)) throw new Error(`refusing to reset a database on ${u.hostname}: the demo stack is on loopback`);
  if (u.pathname !== `/${DEMO_DATABASE}`) throw new Error(`refusing to reset ${u.pathname.slice(1) || "<none>"}: only ${DEMO_DATABASE}`);
}

export async function resetDemo(url, env) {
  assertDemoTarget(url, env);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    // Second check against the server itself: the URL could be tunneled elsewhere.
    const { rows } = await client.query("SELECT current_database() AS db");
    if (rows[0].db !== DEMO_DATABASE) throw new Error(`connected to ${rows[0].db}, not ${DEMO_DATABASE}; nothing dropped`);
    await client.query("BEGIN");
    await client.query("DROP SCHEMA IF EXISTS aurea CASCADE");
    await client.query("DROP SCHEMA IF EXISTS aurea_migrations CASCADE");
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
  await runMigrations(url);
  return seedDemo(url, env);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  try {
    if (!process.argv.includes("--yes")) throw new Error("this erases the demo database; run again with --yes");
    const n = await resetDemo(url, process.env.AUREA_ENV);
    console.log(`demo reset: ${redact(url)} migrated and seeded (${n} synthetic products)`);
  } catch (err) {
    console.error(`demo reset failed: ${err.message}`);
    process.exitCode = 1;
  }
}
