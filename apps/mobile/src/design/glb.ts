// Fetches a job's GLB_PREVIEW through its short-lived signed URL, checks the SHA-256 the API
// announced and keeps it per revision digest so the last geometry still shows offline.
import { CryptoDigestAlgorithm, digest } from "expo-crypto";
import { ApiError } from "../api";
import type { DesignClient } from "./client";
import type { DesignStore } from "./store";
import type { Job } from "./types";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out += B64[a >> 2] + B64[((a & 3) << 4) | ((b ?? 0) >> 4)]
      + (b === undefined ? "=" : B64[((b & 15) << 2) | ((c ?? 0) >> 6)])
      + (c === undefined ? "=" : B64[c & 63]);
  }
  return out;
}
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");

export type Sha256 = (bytes: Uint8Array<ArrayBuffer>) => Promise<string>;
export const sha256: Sha256 = async (bytes) => hex(await digest(CryptoDigestAlgorithm.SHA256, bytes));

export class GlbIntegrityError extends Error {}

export async function loadGlb(
  client: DesignClient, job: Job, opts: { store?: DesignStore | null; cacheKey?: string; fetchImpl?: typeof fetch; hash?: Sha256 } = {},
): Promise<string> {
  const art = job.artifacts.find((a) => a.kind === "GLB_PREVIEW");
  if (!art) throw new ApiError("unexpected");
  const { url } = await client.artifactUrl(job.id, art.id);
  let r: Response;
  try {
    r = await (opts.fetchImpl ?? fetch)(url);
  } catch {
    throw new ApiError("offline");
  }
  if (!r.ok) throw new ApiError(r.status === 403 ? "forbidden" : "unexpected", r.status);
  const bytes = new Uint8Array(await r.arrayBuffer());
  if ((await (opts.hash ?? sha256)(bytes)) !== art.sha256) throw new GlbIntegrityError("GLB does not match its SHA-256");
  const b64 = toBase64(bytes);
  if (opts.store && opts.cacheKey) await opts.store.putGlb(opts.cacheKey, b64).catch(() => undefined);
  return b64;
}

/** Polls a job until it is final. `signal` stops it when the screen goes away. */
export async function waitForJob(client: DesignClient, id: string, opts: { intervalMs?: number; timeoutMs?: number; signal?: { aborted: boolean } } = {}): Promise<Job> {
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
  for (;;) {
    const job = await client.getJob(id);
    if (job.state === "SUCCEEDED" || job.state === "FAILED" || job.state === "CANCELLED") return job;
    if (opts.signal?.aborted) throw new Error("aborted");
    if (Date.now() > deadline) throw new ApiError("unavailable");
    await new Promise((res) => setTimeout(res, opts.intervalMs ?? 700));
  }
}
