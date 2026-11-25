import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { diffParameters, material, type DesignDocument } from "@aurea/design";
import { massGrams, fixed } from "./decimal";
import type { ArtifactStore } from "./store";
import type { GeometryWorker, WorkerManifest } from "./worker-client";

export const LEASE_S = 180;
export const MAX_ATTEMPTS = 3;

export interface JobRow {
  id: string;
  kind: "PREVIEW" | "GEOMETRY";
  state: string;
  project_id: string;
  revision_id: string;
  operation: unknown;
  document: DesignDocument;
  input_digest: string;
  simulated: boolean;
  error_code: string | null;
  summary: unknown;
  attempts: number;
}
interface ArtifactRow { id: string; kind: string; units: string; name: string; sha256: string; bytes: string }

export const JOB_COLUMNS = "id, kind, state, project_id, revision_id, operation, document, input_digest, simulated, error_code, summary, attempts";

export function toJob(j: JobRow, artifacts: ArtifactRow[]) {
  return {
    id: j.id, kind: j.kind, state: j.state, projectId: j.project_id, revisionId: j.revision_id, simulated: j.simulated,
    errorCode: j.state === "FAILED" ? j.error_code : null,
    artifacts: j.state === "SUCCEEDED"
      ? artifacts.map((a) => ({ id: a.id, kind: a.kind, units: a.units, name: a.name, sha256: a.sha256, bytes: Number(a.bytes) }))
      : [],
    summary: j.state === "SUCCEEDED" ? j.summary : null,
  };
}

export async function jobArtifacts(c: Pool | PoolClient, jobId: string): Promise<ArtifactRow[]> {
  return (await c.query<ArtifactRow>("SELECT id, kind, units, name, sha256, bytes FROM aurea.job_artifact WHERE job_id = $1 ORDER BY name", [jobId])).rows;
}

/** JobSummary from the worker manifest: exact-decimal volume and estimated mass per component. */
export function summarize(document: DesignDocument, base: DesignDocument | null, m: WorkerManifest) {
  return {
    document,
    changes: base ? diffParameters(base, document).map((d) => ({ ...d, from: d.from ?? null })) : [],
    components: m.components.map((c) => {
      const alloy = material(c.materialId);
      if (!alloy) throw new Error("component material not in catalog");
      const [[x0, y0, z0], [x1, y1, z1]] = c.boundingBoxMm;
      const wall = m.dfm.findings.find((f) => f.rule === "DFM-02" && f.component === c.id)?.measured;
      return {
        id: c.id, family: c.family, materialId: c.materialId,
        volumeMm3: fixed(c.brepVolumeMm3, 3),
        massGramsEstimate: massGrams(c.brepVolumeMm3, alloy.densityGPerCm3),
        densityStatus: alloy.densityStatus,
        boundingBoxMm: [x1 - x0, y1 - y0, z1 - z0].map((v) => Math.round(v * 1000) / 1000),
        minWallMm: typeof wall === "number" ? Math.round(wall * 1000) / 1000 : 0,
      };
    }),
    dfmState: m.dfm.state,
    humanApprovalRequired: true as const,
    engineVersion: m.engineVersion,
    status: m.status,
  };
}

/**
 * Durable queue on PostgreSQL (job table): claim with SKIP LOCKED and a lease, so a crashed API
 * leaves the job to be re-claimed; bounded retries; a result for a cancelled or re-leased job is
 * dropped (machines.json Job). Results with the same input digest in the same project are reused.
 */
export class JobRunner {
  private readonly log = new Logger("jobs");
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(private readonly pool: Pool, private readonly worker: GeometryWorker, private readonly store: ArtifactStore) {}

  start(intervalMs = 500): void {
    this.timer = setInterval(() => void this.drain(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Run jobs until the queue is empty. Returns how many were processed. */
  async drain(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    let n = 0;
    try {
      while (await this.tick()) n++;
    } catch (err) {
      this.log.warn(`job runner paused: ${(err as Error).constructor.name}`);
    } finally {
      this.busy = false;
    }
    return n;
  }

  /** Claim and run one job. */
  async tick(): Promise<boolean> {
    const claimed = await this.pool.query<JobRow & { lease: string }>(
      `UPDATE aurea.job SET state = 'RUNNING', attempts = attempts + 1, lease_until = now() + make_interval(secs => $1), updated_at = now()
        WHERE id = (SELECT id FROM aurea.job
                     WHERE state = 'QUEUED' OR (state = 'RUNNING' AND lease_until < now())
                     ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING ${JOB_COLUMNS}, lease_until::text AS lease`,
      [LEASE_S],
    );
    const job = claimed.rows[0];
    if (!job) return false;
    if (job.attempts > MAX_ATTEMPTS) {
      await this.finish(job, "FAILED", { errorCode: "GEOMETRY_FAILED" });
      return true;
    }
    if (await this.reuse(job)) return true;
    const result = await this.worker.regenerate(job.id, job.document);
    if (!result.ok) {
      if (result.retry && job.attempts < MAX_ATTEMPTS) {
        await this.pool.query(
          "UPDATE aurea.job SET state = 'QUEUED', lease_until = NULL, updated_at = now() WHERE id = $1 AND state = 'RUNNING' AND lease_until = $2",
          [job.id, job.lease]);
      } else {
        await this.finish(job, "FAILED", { errorCode: result.code });
      }
      return true;
    }
    for (const f of result.files) this.store.put(Buffer.from(f.contentBase64, "base64"), f.sha256);
    const base = job.kind === "PREVIEW"
      ? (await this.pool.query<{ document: DesignDocument }>("SELECT document FROM aurea.revision WHERE id = $1", [job.revision_id])).rows[0].document
      : null;
    let summary;
    try {
      summary = summarize(job.document, base, result.manifest);
    } catch {
      await this.finish(job, "FAILED", { errorCode: "GEOMETRY_FAILED" });
      return true;
    }
    await this.finish(job, "SUCCEEDED", {
      summary,
      artifacts: result.files.map((f) => ({ kind: f.kind, units: f.units, name: f.name, sha256: f.sha256, bytes: f.bytes })),
    });
    return true;
  }

  private async reuse(job: JobRow & { lease: string }): Promise<boolean> {
    const { rows } = await this.pool.query<{ id: string; summary: { document: DesignDocument } }>(
      `SELECT id, summary FROM aurea.job WHERE state = 'SUCCEEDED' AND project_id = $1 AND input_digest = $2 AND id <> $3
        ORDER BY updated_at DESC LIMIT 1`,
      [job.project_id, job.input_digest, job.id]);
    const prior = rows[0];
    if (!prior) return false;
    const artifacts = (await jobArtifacts(this.pool, prior.id)).filter((a) => this.store.has(a.sha256));
    if (!artifacts.length) return false;
    const base = job.kind === "PREVIEW"
      ? (await this.pool.query<{ document: DesignDocument }>("SELECT document FROM aurea.revision WHERE id = $1", [job.revision_id])).rows[0].document
      : null;
    const summary = { ...(prior.summary as object), document: job.document,
      changes: base ? diffParameters(base, job.document).map((d) => ({ ...d, from: d.from ?? null })) : [] };
    await this.finish(job, "SUCCEEDED", { summary, artifacts: artifacts.map((a) => ({ ...a, bytes: Number(a.bytes) })) });
    return true;
  }

  /** Only the holder of the current lease may finish; a late result for a cancelled job is dropped. */
  private async finish(
    job: JobRow & { lease: string },
    state: "SUCCEEDED" | "FAILED",
    out: { errorCode?: string; summary?: unknown; artifacts?: { kind: string; units: string; name: string; sha256: string; bytes: number }[] },
  ): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const upd = await c.query(
        `UPDATE aurea.job SET state = $2, error_code = $3, summary = $4, lease_until = NULL, updated_at = now()
          WHERE id = $1 AND state = 'RUNNING' AND lease_until = $5`,
        [job.id, state, out.errorCode ?? null, out.summary ? JSON.stringify(out.summary) : null, job.lease]);
      if (upd.rowCount === 1) {
        for (const a of out.artifacts ?? []) {
          await c.query("INSERT INTO aurea.job_artifact(id, job_id, kind, units, name, sha256, bytes) VALUES ($1,$2,$3,$4,$5,$6,$7)",
            [randomUUID(), job.id, a.kind, a.units, a.name, a.sha256, a.bytes]);
        }
      }
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }
}
