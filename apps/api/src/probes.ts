import Redis from "ioredis";
import { Client } from "pg";
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
  // One short-lived client per check: a hung server can never hold probe connections.
  // statement_timeout makes PostgreSQL cancel the query itself; on any failure the socket is destroyed.
  const pingDatabase = async () => {
    const client = new Client({
      connectionString: config.databaseUrl,
      connectionTimeoutMillis: TIMEOUT_MS,
      query_timeout: TIMEOUT_MS,
      statement_timeout: TIMEOUT_MS,
    });
    client.on("error", () => undefined);
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
    } catch (err) {
      (client as unknown as { connection?: { stream?: { destroy(): void } } }).connection?.stream?.destroy();
      throw err;
    }
  };
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
        run(pingDatabase),
        run(async () => {
          if (valkey.status === "wait" || valkey.status === "end") await valkey.connect();
          if ((await valkey.ping()) !== "PONG") throw new Error("bad ping");
        }),
      ]);
      return { database, valkey: vk };
    },
    async close() {
      valkey.disconnect();
    },
  };
}
