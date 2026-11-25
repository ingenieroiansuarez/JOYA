import { workerSignature } from "./signing";

export interface WorkerFile { name: string; kind: string; units: string; sha256: string; bytes: number; contentBase64: string }
export interface WorkerComponent {
  id: string;
  family: string;
  materialId: string;
  brepVolumeMm3: number;
  analyticVolumeMm3: number;
  boundingBoxMm: [[number, number, number], [number, number, number]];
}
export interface WorkerManifest {
  status: string;
  engineVersion: string;
  kernelVersion: string;
  inputDigest: string;
  components: WorkerComponent[];
  dfm: { state: "PASS" | "WARN" | "REVIEW" | "FAIL"; humanApprovalRequired: boolean; findings: { rule: string; component: string; measured: number | null }[] };
}
export type WorkerResult =
  | { ok: true; manifest: WorkerManifest; files: WorkerFile[] }
  | { ok: false; retry: boolean; code: string; details?: { code: string; path: string; message: string }[] };

/** Calls services/geometry `POST /v1/regenerate`, signed with the shared worker secret. */
export class GeometryWorker {
  constructor(private readonly url: string, private readonly secret: string, private readonly timeoutMs: number) {}

  async regenerate(jobId: string, document: unknown): Promise<WorkerResult> {
    const path = "/v1/regenerate";
    const body = Buffer.from(JSON.stringify({ jobId, document }));
    let res: Response;
    try {
      res = await fetch(this.url + path, {
        method: "POST",
        body,
        headers: { "content-type": "application/json", "x-aurea-signature": workerSignature(this.secret, "POST", path, body) },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return { ok: false, retry: true, code: "SERVICE_UNAVAILABLE" };
    }
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok && json && Array.isArray(json.files)) return { ok: true, manifest: json.manifest as WorkerManifest, files: json.files as WorkerFile[] };
    if (res.status === 422) return { ok: false, retry: false, code: "INVALID_DOCUMENT", details: (json?.details as never) ?? [] };
    if (res.status === 504) return { ok: false, retry: false, code: "GEOMETRY_TIMEOUT" };
    if (res.status === 503) return { ok: false, retry: true, code: "SERVICE_UNAVAILABLE" };
    return { ok: false, retry: false, code: "GEOMETRY_FAILED" };
  }
}
