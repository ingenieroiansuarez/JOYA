import { Body, Controller, Get, Headers, HttpCode, Inject, NotFoundException, Optional, Param, Post, Req, ServiceUnavailableException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { DATABASE } from "../database";
import { RequirePermission } from "../identity/permission.decorator";
import type { Principal } from "../identity/principal";
import { ApiError } from "./api-error";
import type { DesignConfig } from "./config";
import { JOB_COLUMNS, jobArtifacts, toJob, type JobRow } from "./jobs";
import { digestOf, idempotent, ownedProject, tx, uuidParam } from "./repo";
import { fileSignature, FILE_URL_TTL_S } from "./signing";

export const DESIGN_CONFIG = Symbol("DESIGN_CONFIG");
interface AuthedRequest { principal: Principal; protocol: string; header(name: string): string | undefined }
const QUALITIES = ["INTERACTIVE", "LUXURY", "PHOTOREAL"];

/** OpenAPI jobs tag + generateGeometry. A job is visible only to the owner of its project. */
@Controller()
export class JobsController {
  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Optional() @Inject(DESIGN_CONFIG) private readonly design: DesignConfig | null,
  ) {}

  private async ownedJob(subject: string, id: string): Promise<JobRow> {
    const { rows } = await this.pool.query<JobRow>(
      `SELECT ${JOB_COLUMNS.split(", ").map((c) => `j.${c}`).join(", ")} FROM aurea.job j
         JOIN aurea.project p ON p.id = j.project_id JOIN aurea.customer c ON c.id = p.owner_id
        WHERE j.id = $1 AND c.subject = $2`,
      [id, subject]);
    if (!rows[0]) throw new NotFoundException();
    return rows[0];
  }

  @Get("jobs/:id")
  @RequirePermission("job.read")
  async get(@Req() req: AuthedRequest, @Param("id") id: string) {
    const job = await this.ownedJob(req.principal.subject, uuidParam(id, "/id"));
    return toJob(job, await jobArtifacts(this.pool, job.id));
  }

  @Get("jobs/:id/artifacts/:artifactId")
  @RequirePermission("job.read")
  async artifact(@Req() req: AuthedRequest, @Param("id") id: string, @Param("artifactId") artifactId: string) {
    if (!this.design) throw new ServiceUnavailableException();
    const job = await this.ownedJob(req.principal.subject, uuidParam(id, "/id"));
    const a = (await jobArtifacts(this.pool, job.id)).find((x) => x.id === uuidParam(artifactId, "/artifactId"));
    if (!a || job.state !== "SUCCEEDED") throw new NotFoundException();
    const exp = Math.floor(Date.now() / 1000) + FILE_URL_TTL_S;
    // local/ci without API_PUBLIC_URL: the address the caller used (it only reaches the caller).
    const base = this.design.publicUrl ?? `${req.protocol}://${req.header("host")}`;
    return {
      url: `${base}/v1/files/${a.sha256}?exp=${exp}&sig=${fileSignature(this.design.fileUrlSecret, a.sha256, exp)}`,
      expiresAt: new Date(exp * 1000).toISOString(),
      sha256: a.sha256,
    };
  }

  /** generateGeometry: export a stored revision (STEP, STL, GLB, DFM, manifest). */
  @Post("geometry/jobs")
  @HttpCode(202)
  @RequirePermission("project.edit")
  async generate(@Req() req: AuthedRequest, @Body() raw: { revisionId?: string; quality?: string }, @Headers("idempotency-key") key?: string) {
    if (!raw || typeof raw !== "object" || Object.keys(raw).some((k) => k !== "revisionId" && k !== "quality") || !QUALITIES.includes(String(raw.quality))) {
      throw new ApiError(400, "VALIDATION_FAILED", [{ code: "VALIDATION_FAILED", pointer: "", message: "revisionId and quality (INTERACTIVE, LUXURY, PHOTOREAL) are required" }]);
    }
    const revisionId = uuidParam(raw.revisionId, "/revisionId");
    const subject = req.principal.subject;
    return tx(this.pool, (c) => idempotent(c, subject, "generateGeometry", key, raw, async () => {
      const { rows: revs } = await c.query<{ project_id: string; document: object }>(
        `SELECT r.project_id, r.document FROM aurea.revision r JOIN aurea.project p ON p.id = r.project_id
           JOIN aurea.customer cu ON cu.id = p.owner_id WHERE r.id = $1 AND cu.subject = $2`, [revisionId, subject]);
      if (!revs[0]) throw new NotFoundException();
      await ownedProject(c, subject, revs[0].project_id);
      const { rows } = await c.query<JobRow>(
        `INSERT INTO aurea.job(id, kind, actor, project_id, revision_id, document, input_digest, quality)
         VALUES ($1,'GEOMETRY',$2,$3,$4,$5,$6,$7) RETURNING ${JOB_COLUMNS}`,
        [randomUUID(), subject, revs[0].project_id, revisionId, revs[0].document, digestOf(revs[0].document), raw.quality]);
      return toJob(rows[0], []);
    }));
  }
}
