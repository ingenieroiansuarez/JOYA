import { isAbsolute, resolve } from "node:path";
import { ConfigError, type Environment } from "../config";

export interface DesignConfig {
  /** Internal geometry worker (services/geometry `aurea-geometry-worker`). */
  workerUrl: string;
  workerSecret: string;
  /** Key that signs short-lived download URLs (GET /v1/files/{sha256}). */
  fileUrlSecret: string;
  /** Content-addressed artifact store (local directory; S3 in a later milestone). */
  artifactDir: string;
  /** Absolute base for download URLs; local/ci may derive it from the request. */
  publicUrl: string | null;
  workerTimeoutMs: number;
}

const MIN_SECRET = 32;

/** Fails closed like loadConfig: the API refuses to start without the worker and signing secrets. */
export function loadDesignConfig(source: NodeJS.ProcessEnv, env: Environment, cwd = process.cwd()): DesignConfig {
  const missing = ["GEOMETRY_WORKER_URL", "GEOMETRY_WORKER_SECRET", "FILE_URL_SECRET", "ARTIFACT_DIR"].filter((k) => !source[k]);
  if (missing.length) throw new ConfigError(`missing configuration: ${missing.join(", ")}`);
  for (const k of ["GEOMETRY_WORKER_SECRET", "FILE_URL_SECRET"]) {
    if (source[k]!.length < MIN_SECRET) throw new ConfigError(`${k} must be at least ${MIN_SECRET} characters`);
  }
  if (source.GEOMETRY_WORKER_SECRET === source.FILE_URL_SECRET) throw new ConfigError("GEOMETRY_WORKER_SECRET and FILE_URL_SECRET must differ");
  let worker: URL;
  try {
    worker = new URL(source.GEOMETRY_WORKER_URL!);
  } catch {
    throw new ConfigError("GEOMETRY_WORKER_URL is not a URL");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(worker.hostname);
  if (worker.protocol !== "https:" && !(worker.protocol === "http:" && (loopback || env === "local" || env === "ci"))) {
    throw new ConfigError("GEOMETRY_WORKER_URL must use https outside loopback in demo/production");
  }
  const publicUrl = source.API_PUBLIC_URL ?? null;
  if (!publicUrl && (env === "demo" || env === "production")) throw new ConfigError(`API_PUBLIC_URL is required in ${env}`);
  if (publicUrl) {
    try {
      new URL(publicUrl);
    } catch {
      throw new ConfigError("API_PUBLIC_URL is not a URL");
    }
  }
  const dir = source.ARTIFACT_DIR!;
  return {
    workerUrl: worker.toString().replace(/\/$/, ""),
    workerSecret: source.GEOMETRY_WORKER_SECRET!,
    fileUrlSecret: source.FILE_URL_SECRET!,
    artifactDir: isAbsolute(dir) ? dir : resolve(cwd, dir),
    publicUrl: publicUrl ? publicUrl.replace(/\/$/, "") : null,
    workerTimeoutMs: Number(source.GEOMETRY_WORKER_TIMEOUT_MS ?? 90_000),
  };
}
