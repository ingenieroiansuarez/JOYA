// Applies packages/db/migrations in order (Drizzle migrator, one transaction).
// Fails closed: DATABASE_URL is required and nothing is defaulted; credentials are never logged.
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

export const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));

export function redact(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}:${u.port || 5432}${u.pathname}`;
  } catch {
    return "<invalid DATABASE_URL>";
  }
}

export async function runMigrations(url) {
  if (!url) throw new Error("DATABASE_URL is not set; refusing to guess a database");
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS, migrationsSchema: "aurea_migrations" });
  } finally {
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  try {
    await runMigrations(url);
    console.log(`migrations applied to ${redact(url)}`);
  } catch (err) {
    console.error(`migration failed on ${url ? redact(url) : "<unset>"}: ${err.message}`);
    process.exitCode = 1;
  }
}
