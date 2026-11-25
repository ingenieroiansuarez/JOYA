import Redis from "ioredis";
import { Pool } from "pg";
import type { Config } from "./config";

export const PROBES = Symbol("PROBES");
export type CheckResult = "ok" | "down";

export interface Probes {
  check(): Promise<Record<"database" | "valkey", CheckResult>>;
  close(): Promise<void>;
}

const TIMEOUT_MS = 2000;

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS).unref())]);
}

export function createProbes(config: Config): Probes {
  const pool = new Pool({ connectionString: config.databaseUrl, max: 2, connectionTimeoutMillis: TIMEOUT_MS });
  pool.on("error", () => undefined); // idle client errors surface through check()
  const valkey = new Redis(config.valkeyUrl, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
  valkey.on("error", () => undefined);
  const run = async (fn: () => Promise<unknown>): Promise<CheckResult> => {
    try {
      await withTimeout(fn());
      return "ok";
    } catch {
      return "down";
    }
  };
  return {
    async check() {
      const [database, vk] = await Promise.all([
        run(() => pool.query("SELECT 1")),
        run(async () => {
          if (valkey.status === "wait" || valkey.status === "end") await valkey.connect();
          if ((await valkey.ping()) !== "PONG") throw new Error("bad ping");
        }),
      ]);
      return { database, valkey: vk };
    },
    async close() {
      valkey.disconnect();
      await pool.end();
    },
  };
}
