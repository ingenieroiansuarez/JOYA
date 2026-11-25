import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { applyOperation, MAIN_BRANCH, newDocument, type DesignOperation } from "@aurea/design";
import { DATABASE } from "../database";
import { correlationId } from "../errors.filter";
import { RequirePermission } from "../identity/permission.decorator";
import type { Principal } from "../identity/principal";
import { acceptProposalPreview, markProposalAccepted } from "../ai/ai.controller";
import { ApiError, toDetails } from "./api-error";
import { JOB_COLUMNS, jobArtifacts, toJob, type JobRow } from "./jobs";
import {
  appendRevision, decodeCursor, digestOf, encodeCursor, ensureCustomer, idempotent, listOwnedProjects, ownedProject,
  revision, revisionEvent, revisionsPage, toProject, toRevision, toRevisionSummary, tx, uuidParam, type RevisionRow,
} from "./repo";

interface AuthedRequest { principal: Principal; header(name: string): string | undefined }
const PAGE = 20;

function body<T extends object>(b: unknown, allowed: (keyof T)[]): T {
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new ApiError(400, "VALIDATION_FAILED");
  const extra = Object.keys(b).filter((k) => !allowed.includes(k as keyof T));
  if (extra.length) {
    throw new ApiError(400, "VALIDATION_FAILED", extra.map((k) => ({ code: "VALIDATION_FAILED", pointer: `/${k}`, message: "unknown property" })));
  }
  return b as T;
}

/** OpenAPI projects tag. Scope `own` everywhere: every query is keyed by the token subject. */
@Controller("projects")
export class ProjectsController {
  constructor(@Inject(DATABASE) private readonly pool: Pool) {}

  @Get()
  @RequirePermission("project.read")
  async list(@Req() req: AuthedRequest, @Query("cursor") cursor?: string) {
    const after = decodeCursor(cursor) as [string, string] | null;
    const rows = await listOwnedProjects(this.pool, req.principal.subject, after, PAGE);
    const page = rows.slice(0, PAGE);
    const last = page[page.length - 1];
    return { items: page.map(toProject), nextCursor: rows.length > PAGE ? encodeCursor([last.updated_at, last.id]) : null };
  }

  @Post()
  @HttpCode(200)
  @RequirePermission("project.create")
  async create(@Req() req: AuthedRequest, @Body() raw: unknown, @Headers("idempotency-key") key?: string) {
    const b = body<{ title: string; templateId: string; materialId: string }>(raw, ["title", "templateId", "materialId"]);
    const title = typeof b.title === "string" ? b.title.trim() : "";
    if (!title || title.length > 80 || typeof b.templateId !== "string" || typeof b.materialId !== "string") {
      throw new ApiError(400, "VALIDATION_FAILED", [{ code: "VALIDATION_FAILED", pointer: "", message: "title (1-80), templateId and materialId are required" }]);
    }
    const subject = req.principal.subject;
    return tx(this.pool, (c) => idempotent(c, subject, "createProject", key, b, async () => {
      const projectId = randomUUID();
      const made = newDocument({ projectId, familyId: b.templateId, materialId: b.materialId });
      if (!made.ok) throw new ApiError(422, "INVALID_DOCUMENT", toDetails(made.issues));
      const owner = await ensureCustomer(c, subject);
      await c.query("INSERT INTO aurea.project(id, owner_id, title, family_id) VALUES ($1,$2,$3,$4)", [projectId, owner, title, b.templateId]);
      const revisionId = randomUUID();
      const { rows } = await c.query<RevisionRow>(
        `INSERT INTO aurea.revision(id, project_id, number, document, digest, created_by, source)
         VALUES ($1,$2,1,$3,$4,$5,'CREATE') RETURNING id, project_id, parent_id, number, document, digest, state, source, created_at::text`,
        [revisionId, projectId, made.document, digestOf(made.document), subject]);
      await c.query(`INSERT INTO aurea.branch(project_id, name, head_id) VALUES ($1, '${MAIN_BRANCH}', $2)`, [projectId, revisionId]);
      await revisionEvent(c, rows[0], correlationId(req));
      return toProject(await ownedProject(c, subject, projectId));
    }));
  }

  @Get(":id")
  @RequirePermission("project.read")
  async get(@Req() req: AuthedRequest, @Param("id") id: string) {
    return toProject(await ownedProject(this.pool, req.principal.subject, uuidParam(id, "/id")));
  }

  @Get(":id/revisions")
  @RequirePermission("project.read")
  async revisions(@Req() req: AuthedRequest, @Param("id") id: string, @Query("cursor") cursor?: string) {
    const p = await ownedProject(this.pool, req.principal.subject, uuidParam(id, "/id"));
    const before = decodeCursor(cursor);
    const beforeNumber = before ? Number(before[0]) : null;
    if (before && !Number.isInteger(beforeNumber)) throw new ApiError(400, "VALIDATION_FAILED");
    const rows = await revisionsPage(this.pool, p.id, beforeNumber, PAGE);
    const page = rows.slice(0, PAGE);
    return { items: page.map(toRevisionSummary), nextCursor: rows.length > PAGE ? encodeCursor([page[page.length - 1].number]) : null };
  }

  @Get(":id/revisions/:revisionId")
  @RequirePermission("project.read")
  async getRevision(@Req() req: AuthedRequest, @Param("id") id: string, @Param("revisionId") revisionId: string) {
    const p = await ownedProject(this.pool, req.principal.subject, uuidParam(id, "/id"));
    return toRevision(await revision(this.pool, p.id, uuidParam(revisionId, "/revisionId")));
  }

  /** proposeOperation: validate and queue a PREVIEW regeneration. Never creates a revision. */
  @Post(":id/operations")
  @HttpCode(202)
  @RequirePermission("project.edit")
  async propose(@Req() req: AuthedRequest, @Param("id") id: string, @Body() raw: unknown, @Headers("idempotency-key") key?: string) {
    const b = body<{ baseRevisionId: string; operation: DesignOperation }>(raw, ["baseRevisionId", "operation"]);
    const projectId = uuidParam(id, "/id");
    const baseId = uuidParam(b.baseRevisionId, "/baseRevisionId");
    const subject = req.principal.subject;
    return tx(this.pool, (c) => idempotent(c, subject, `proposeOperation:${projectId}`, key, b, async () => {
      const p = await ownedProject(c, subject, projectId);
      if (p.head_id !== baseId) throw new ApiError(409, "VERSION_CONFLICT", [{ code: "VERSION_CONFLICT", pointer: "/baseRevisionId", message: "base is not the head of main" }]);
      const base = await revision(c, p.id, baseId);
      const r = applyOperation(base.document, b.operation);
      if (!r.ok) {
        // Writing the current value is not an invalid document: nothing to regenerate, no revision.
        const unchanged = r.issues.every((i) => i.code === "NO_CHANGE");
        throw new ApiError(422, unchanged ? "INVARIANT_VIOLATED" : "INVALID_DOCUMENT", toDetails(r.issues));
      }
      const { rows } = await c.query<JobRow>(
        `INSERT INTO aurea.job(id, kind, actor, project_id, revision_id, operation, document, input_digest, quality)
         VALUES ($1,'PREVIEW',$2,$3,$4,$5,$6,$7,'INTERACTIVE') RETURNING ${JOB_COLUMNS}`,
        [randomUUID(), subject, p.id, base.id, JSON.stringify(b.operation), r.document, digestOf(r.document)]);
      return toJob(rows[0], []);
    }));
  }

  /** createRevision: accept a finished preview; the revision holds exactly the document it built. */
  @Post(":id/revisions")
  @HttpCode(200)
  @RequirePermission("project.edit")
  async accept(@Req() req: AuthedRequest, @Param("id") id: string, @Body() raw: unknown, @Headers("idempotency-key") key?: string) {
    const b = body<{ baseRevisionId: string; previewJobId: string; accepted: boolean }>(raw, ["baseRevisionId", "previewJobId", "accepted"]);
    const projectId = uuidParam(id, "/id");
    const baseId = uuidParam(b.baseRevisionId, "/baseRevisionId");
    const jobId = uuidParam(b.previewJobId, "/previewJobId");
    if (b.accepted !== true) {
      throw new ApiError(422, "INVARIANT_VIOLATED", [{ code: "INVARIANT_VIOLATED", pointer: "/accepted", message: "a revision needs the person's explicit acceptance" }]);
    }
    const subject = req.principal.subject;
    return tx(this.pool, (c) => idempotent(c, subject, `createRevision:${projectId}`, key, b, async () => {
      const p = await ownedProject(c, subject, projectId, true);
      const { rows } = await c.query<JobRow>(`SELECT ${JOB_COLUMNS} FROM aurea.job WHERE id = $1 AND project_id = $2 AND kind = 'PREVIEW'`, [jobId, p.id]);
      const job = rows[0];
      if (!job) throw new ApiError(404, "NOT_FOUND");
      if (job.revision_id !== baseId) throw new ApiError(422, "INVARIANT_VIOLATED", [{ code: "INVARIANT_VIOLATED", pointer: "/previewJobId", message: "preview was made on another base" }]);
      if (job.state !== "SUCCEEDED") throw new ApiError(409, "RESULT_NOT_READY");
      if (p.head_id !== baseId) throw new ApiError(409, "VERSION_CONFLICT", [{ code: "VERSION_CONFLICT", pointer: "/baseRevisionId", message: "base is not the head of main" }]);
      // A preview of an AURA proposal: the proposal must still be open on this very preview.
      const proposalId = await acceptProposalPreview(c, job);
      const r = await appendRevision(c, {
        project: p, document: job.document, actor: subject, source: proposalId ? "AI" : "PREVIEW", sourceId: proposalId ?? job.id, correlationId: correlationId(req),
      });
      if (proposalId) await markProposalAccepted(c, proposalId, r.id);
      return toRevision(r);
    }));
  }
}

export { jobArtifacts };
