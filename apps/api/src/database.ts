import { ServiceUnavailableException } from "@nestjs/common";
import { Pool } from "pg";
import type { Config } from "./config";

export const DATABASE = Symbol("DATABASE");

/** Lazy pool: nothing connects until the first query, so a process without traffic never touches the database. */
export function createPool(config: Config): Pool {
  const pool = new Pool({ connectionString: config.databaseUrl, max: 10, connectionTimeoutMillis: 2000, statement_timeout: 5000 });
  pool.on("error", () => undefined); // idle-client errors; the next query reports them
  return pool;
}

// Connection-level failures (refused, timeout, server shutting down, too many clients) are 503, not 500:
// the client may retry. Everything else stays a 500 and is logged by ErrorsFilter without its message.
const UNAVAILABLE_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "57P01", "57P03", "53300"]);

export function isUnavailable(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  if (e.code && UNAVAILABLE_CODES.has(e.code)) return true;
  return /timeout exceeded when trying to connect|Connection terminated/i.test(e.message ?? "");
}

export async function query<T>(pool: Pool, sql: string, params: unknown[] = []): Promise<T[]> {
  try {
    return (await pool.query(sql, params)).rows as T[];
  } catch (err) {
    if (isUnavailable(err)) throw new ServiceUnavailableException();
    throw err;
  }
}
