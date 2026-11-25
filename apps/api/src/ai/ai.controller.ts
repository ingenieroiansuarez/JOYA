import { Body, Controller, Get, Headers, HttpCode, Inject, Logger, NotFoundException, Optional, Param, Post, Req } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { applyAll, canonicalJson, diffParameters, type DesignDocument, type DesignOperation } from "@aurea/design";
import { DATABASE } from "../database";
import { RequirePermission } from "../identity/permission.decorator";
import type { Principal } from "../identity/principal";
import { ApiError } from "../design/api-error";
import { JOB_COLUMNS, toJob, type JobRow } from "../design/jobs";
import { digestOf, idempotent, ownedProject, revision, sha256, tx, uuidParam } from "../design/repo";
import type { AdapterResult, AiAdapter, Locale, Note } from "./adapter";
import type { AiConfig } from "./config";

export const AI_RUNTIME = Symbol("AI_RUNTIME");
export interface AiRuntime { config: AiConfig; adapter: AiAdapter }
interface AuthedRequest { principal: Principal; header(name: string): string | undefined }

export interface ProposalOption {
  index: number;
  title: string;
  summary: string;
  operations: DesignOperation[];
  changes: { componentId: string; name: string; from: unknown; to: unknown }[];
  assumptions: string[];
  previewRequired: true;
}
interface StoredResult { understood: string[]; notes: Note[]; options: ProposalOption[] }
interface ProposalRow {
  id: string; actor: string; project_id: string; base_revision_id: string; state: string; provider: string; model: string;
  simulated: boolean; locale: Locale; result: StoredResult; preview_option: number | null; preview_job_id: string | null;
  revision_id: string | null; created_at: string; expires_at: string; expired: boolean;
}
const PROPOSAL_COLUMNS = `id, actor, project_id, base_revision_id, state, provider, model, simulated, locale, result, preview_option,
  preview_job_id, revision_id, created_at::text, expires_at::text, (expires_at <= now()) AS expired`;

const OPEN = ["PROPOSED", "PREVIEWING"];
const MAX_OPS = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bad = (pointer: string, message: string) => new ApiError(400, "VALIDATION_FAILED", [{ code: "VALIDATION_FAILED", pointer, message }]);
const str = (v: unknown, max: number) => (typeof v === "string" ? v : "").slice(0, max);

function toProposal(r: ProposalRow) {
  const state = OPEN.includes(r.state) && r.expired ? "EXPIRED" : r.state;
  return {
    id: r.id, projectId: r.project_id, baseRevisionId: r.base_revision_id, state,
    provider: { id: r.provider, model: r.model, simulated: r.simulated }, locale: r.locale,
    understood: r.result.understood, notes: r.result.notes, options: r.result.options,
    previewOptionIndex: r.preview_option, previewJobId: r.preview_job_id, revisionId: r.revision_id,
    createdAt: new Date(r.created_at).toISOString(), expiresAt: new Date(r.expires_at).toISOString(),
  };
}

/**
 * Adapter output is untrusted (AI_ARCHITECTURE.md): rebuild every operation from the allowlist,
 * apply it to the base with the same rules as the editor, drop what does not validate or changes
 * nothing, and drop duplicates. What survives is only ever a proposal.
 */
export function normalize(doc: DesignDocument, raw: AdapterResult, maxOptions: number): StoredResult {
  const options: ProposalOption[] = [];
  const seen = new Set<string>();
  for (const o of Array.isArray(raw.options) ? raw.options : []) {
    if (options.length >= maxOptions) break;
    if (!o || !Array.isArray(o.operations) || o.operations.length < 1 || o.operations.length > MAX_OPS) continue;
    const ops: DesignOperation[] = [];
    for (const op of o.operations as Record<string, unknown>[]) {
      if (op?.type === "modify_parameter" && typeof op.componentId === "string" && typeof op.name === "string"
        && typeof op.value === "number" && Number.isFinite(op.value)) {
        ops.push({ type: "modify_parameter", componentId: op.componentId, name: op.name, value: op.value });
      } else if (op?.type === "change_material" && typeof op.componentId === "string" && typeof op.materialId === "string") {
        ops.push({ type: "change_material", componentId: op.componentId, materialId: op.materialId });
      } else {
        ops.length = 0;
        break;
      }
    }
    if (!ops.length) continue;
    const r = applyAll(doc, ops);
    if (!r.ok) continue;
    const key = digestOf(r.document);
    if (key === digestOf(doc) || seen.has(key)) continue;
    seen.add(key);
    options.push({
      index: options.length, title: str(o.title, 80), summary: str(o.summary, 300), operations: ops,
      changes: diffParameters(doc, r.document).map((d) => ({ ...d, from: d.from ?? null })),
      assumptions: (Array.isArray(o.assumptions) ? o.assumptions : []).slice(0, 5).map((a) => str(a, 300)),
      previewRequired: true,
    });
  }
  const notes = (Array.isArray(raw.notes) ? raw.notes : []).slice(0, 10).map((n) => ({ code: n.code, message: str(n.message, 300) }));
  const understood = (Array.isArray(raw.understood) ? raw.understood : []).slice(0, 10).map((u) => str(u, 120));
  return { understood, notes, options };
}

async function used(c: Pool | PoolClient, actor: string): Promise<{ day: string; used: number }> {
  const { rows } = await c.query<{ day: string; used: string }>(
    `SELECT (now() AT TIME ZONE 'UTC')::date::text AS day,
            COALESCE(SUM(CASE entry WHEN 'RESERVE' THEN units WHEN 'RELEASE' THEN -units ELSE 0 END), 0)::text AS used
       FROM aurea.ai_usage WHERE actor = $1 AND day = (now() AT TIME ZONE 'UTC')::date`, [actor]);
  return { day: rows[0].day, used: Number(rows[0].used) };
}

/** AURA gateway (OpenAPI ai tag). Proposals never change a project; a person accepts a preview. */
@Controller("ai")
export class AiController {
  private readonly log = new Logger("aura");
  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Optional() @Inject(AI_RUNTIME) private readonly ai: AiRuntime | null,
  ) {}

  private runtime(): AiRuntime {
    if (!this.ai) throw new ApiError(503, "PROVIDER_NOT_CONFIGURED");
    return this.ai;
  }

  @Get("quota")
  @RequirePermission("ai.generate")
  async quota(@Req() req: AuthedRequest) {
    const { config } = this.runtime();
    const u = await used(this.pool, req.principal.subject);
    const resets = new Date(`${u.day}T00:00:00Z`);
    resets.setUTCDate(resets.getUTCDate() + 1);
    return { day: u.day, limitUnits: config.dailyUnits, usedUnits: u.used, remainingUnits: Math.max(0, config.dailyUnits - u.used), resetsAt: resets.toISOString() };
  }

  @Post("proposals")
  @HttpCode(200)
  @RequirePermission("ai.generate")
  async create(@Req() req: AuthedRequest, @Body() raw: unknown, @Headers("idempotency-key") key?: string) {
    const { config, adapter } = this.runtime();
    if (!key || key.length < 8 || key.length > 128) throw bad("", "Idempotency-Key header (8-128 chars) is required");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad("", "body must be an object");
    const b = raw as Record<string, unknown>;
    const extra = Object.keys(b).filter((k) => !["projectId", "baseRevisionId", "prompt", "locale"].includes(k));
    if (extra.length) throw bad(`/${extra[0]}`, "unknown property");
    if (typeof b.projectId !== "string" || !UUID.test(b.projectId)) throw bad("/projectId", "must be a UUID");
    if (typeof b.baseRevisionId !== "string" || !UUID.test(b.baseRevisionId)) throw bad("/baseRevisionId", "must be a UUID");
    const prompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
    if (!prompt || prompt.length > 2000) throw bad("/prompt", "1-2000 characters");
    if (b.locale !== undefined && b.locale !== "es" && b.locale !== "en") throw bad("/locale", "es or en");
    const locale: Locale = (b.locale as Locale | undefined) ?? (/^en\b/i.test(req.header("accept-language") ?? "") ? "en" : "es");
    const subject = req.principal.subject;
    const projectId = b.projectId.toLowerCase();
    const baseId = b.baseRevisionId.toLowerCase();
    const requestDigest = sha256(canonicalJson({ projectId, baseRevisionId: baseId, prompt, locale }));
    const id = randomUUID();
    const input = { prompt, locale, maxOptions: config.maxOptions } as const;
    const cost = adapter.estimateCost(prompt);

    // 1. Claim the key and reserve quota, or return the stored response.
    const claimed = await tx(this.pool, async (c) => {
      const ins = await c.query(
        "INSERT INTO aurea.idempotency(actor, scope, key, request_digest) VALUES ($1,'createAiProposal',$2,$3) ON CONFLICT DO NOTHING",
        [subject, key, requestDigest]);
      if (ins.rowCount === 0) {
        const { rows } = await c.query<{ request_digest: string; response: unknown }>(
          "SELECT request_digest, response FROM aurea.idempotency WHERE actor=$1 AND scope='createAiProposal' AND key=$2", [subject, key]);
        if (rows[0].request_digest !== requestDigest) throw new ApiError(409, "IDEMPOTENCY_CONFLICT");
        if (rows[0].response !== null) return { done: rows[0].response };
        throw new ApiError(409, "RESULT_NOT_READY");
      }
      const p = await ownedProject(c, subject, projectId);
      if (p.head_id !== baseId) throw new ApiError(409, "VERSION_CONFLICT", [{ code: "VERSION_CONFLICT", pointer: "/baseRevisionId", message: "base is not the head of main" }]);
      const base = await revision(c, p.id, baseId);
      // One reservation at a time per person: the check and the insert cannot interleave.
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended('ai_usage:' || $1, 0))", [subject]);
      const u = await used(c, subject);
      if (u.used + cost > config.dailyUnits) {
        throw new ApiError(429, "QUOTA_EXCEEDED", [{ code: "QUOTA_EXCEEDED", pointer: "", message: `daily limit of ${config.dailyUnits} units reached` }]);
      }
      await c.query("INSERT INTO aurea.ai_usage(id, actor, day, entry, units, request_id, provider) VALUES ($1,$2,$3::date,'RESERVE',$4,$5,$6)",
        [randomUUID(), subject, u.day, cost, id, adapter.id]);
      return { document: base.document, day: u.day };
    });
    if ("done" in claimed) return claimed.done;

    // 2. Call the adapter outside any transaction, with a hard timeout.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), config.timeoutMs);
    let result: StoredResult;
    try {
      const out = await Promise.race([
        adapter.generate({ ...input, document: claimed.document }, abort.signal),
        new Promise<never>((_, reject) => abort.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true })),
      ]);
      result = normalize(claimed.document, out, config.maxOptions);
    } catch (err) {
      this.log.warn(`adapter ${adapter.id} failed: ${abort.signal.aborted ? "timeout" : (err as Error).constructor.name}`);
      // Release the reservation and the key: the person may retry with the same key.
      await tx(this.pool, async (c) => {
        await c.query("INSERT INTO aurea.ai_usage(id, actor, day, entry, units, request_id, provider) VALUES ($1,$2,$3::date,'RELEASE',$4,$5,$6)",
          [randomUUID(), subject, claimed.day, cost, id, adapter.id]);
        await c.query("DELETE FROM aurea.idempotency WHERE actor=$1 AND scope='createAiProposal' AND key=$2", [subject, key]);
      });
      throw new ApiError(503, abort.signal.aborted ? "AI_TIMEOUT" : "AI_PROVIDER_UNAVAILABLE");
    } finally {
      clearTimeout(timer);
    }

    // 3. Store the proposal, confirm the spend and the idempotent response together.
    return tx(this.pool, async (c) => {
      const { rows } = await c.query<ProposalRow>(
        `INSERT INTO aurea.ai_proposal(id, actor, project_id, base_revision_id, provider, model, simulated, prompt_sha256, prompt_chars, locale, result, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now() + make_interval(secs => $12)) RETURNING ${PROPOSAL_COLUMNS}`,
        [id, subject, projectId, baseId, adapter.id, adapter.model, adapter.simulated, sha256(prompt), prompt.length, locale, JSON.stringify(result), config.proposalTtlS]);
      await c.query("INSERT INTO aurea.ai_usage(id, actor, day, entry, units, request_id, provider) VALUES ($1,$2,$3::date,'SPEND',$4,$5,$6)",
        [randomUUID(), subject, claimed.day, cost, id, adapter.id]);
      const out = toProposal(rows[0]);
      await c.query("UPDATE aurea.idempotency SET response = $3 WHERE actor=$1 AND scope='createAiProposal' AND key=$2", [subject, key, JSON.stringify(out)]);
      return out;
    });
  }

  private async owned(c: Pool | PoolClient, subject: string, id: string, lock = false): Promise<ProposalRow> {
    const { rows } = await c.query<ProposalRow>(
      `SELECT ${PROPOSAL_COLUMNS} FROM aurea.ai_proposal WHERE id = $1 AND actor = $2 ${lock ? "FOR UPDATE" : ""}`, [id, subject]);
    if (!rows[0]) throw new NotFoundException();
    return rows[0];
  }

  @Get("proposals/:id")
  @RequirePermission("ai.generate")
  async get(@Req() req: AuthedRequest, @Param("id") id: string) {
    this.runtime();
    return toProposal(await this.owned(this.pool, req.principal.subject, uuidParam(id, "/id")));
  }

  /** Preview one option: a PREVIEW job on the base, like the editor's. The project stays as it was. */
  @Post("proposals/:id/preview")
  @HttpCode(202)
  @RequirePermission("ai.generate")
  async preview(@Req() req: AuthedRequest, @Param("id") id: string, @Body() raw: unknown, @Headers("idempotency-key") key?: string) {
    this.runtime();
    const pid = uuidParam(id, "/id");
    if (!raw || typeof raw !== "object" || Object.keys(raw).some((k) => k !== "optionIndex")) throw bad("", "only optionIndex is allowed");
    const optionIndex = (raw as { optionIndex?: unknown }).optionIndex;
    if (!Number.isInteger(optionIndex) || (optionIndex as number) < 0) throw bad("/optionIndex", "must be an integer ≥ 0");
    if (!key || key.length < 8 || key.length > 128) throw bad("", "Idempotency-Key header (8-128 chars) is required");
    const subject = req.principal.subject;
    const out = await tx(this.pool, async (c) => {
      return idempotent(c, subject, `previewAiProposal:${pid}`, key, raw, async () => {
        const p = await this.owned(c, subject, pid, true);
        if (!OPEN.includes(p.state)) throw new ApiError(409, "INVALID_TRANSITION", [{ code: "INVALID_TRANSITION", pointer: "", message: `proposal is ${p.state}` }]);
        if (p.expired) {
          await c.query("UPDATE aurea.ai_proposal SET state = 'EXPIRED' WHERE id = $1", [p.id]);
          return { expired: true } as const;
        }
        const option = p.result.options[optionIndex as number];
        if (!option) throw new ApiError(422, "INVARIANT_VIOLATED", [{ code: "INVARIANT_VIOLATED", pointer: "/optionIndex", message: "no such option" }]);
        const project = await ownedProject(c, subject, p.project_id);
        if (project.head_id !== p.base_revision_id) {
          throw new ApiError(409, "VERSION_CONFLICT", [{ code: "VERSION_CONFLICT", pointer: "", message: "the design changed after this proposal; ask again" }]);
        }
        const base = await revision(c, p.project_id, p.base_revision_id);
        const r = applyAll(base.document, option.operations);
        if (!r.ok) throw new ApiError(422, "INVALID_DOCUMENT");
        const operation = { kind: "AI_PROPOSAL", proposalId: p.id, optionIndex, operations: option.operations };
        const { rows } = await c.query<JobRow>(
          `INSERT INTO aurea.job(id, kind, actor, project_id, revision_id, operation, document, input_digest, quality)
           VALUES ($1,'PREVIEW',$2,$3,$4,$5,$6,$7,'INTERACTIVE') RETURNING ${JOB_COLUMNS}`,
          [randomUUID(), subject, p.project_id, base.id, JSON.stringify(operation), r.document, digestOf(r.document)]);
        await c.query("UPDATE aurea.ai_proposal SET state = 'PREVIEWING', preview_option = $2, preview_job_id = $3 WHERE id = $1",
          [p.id, optionIndex, rows[0].id]);
        return toJob(rows[0], []);
      });
    });
    if ("expired" in out) throw new ApiError(409, "PROPOSAL_EXPIRED");
    return out;
  }

  @Post("proposals/:id/discard")
  @HttpCode(200)
  @RequirePermission("ai.generate")
  async discard(@Req() req: AuthedRequest, @Param("id") id: string, @Headers("idempotency-key") key?: string) {
    this.runtime();
    const pid = uuidParam(id, "/id");
    if (!key || key.length < 8 || key.length > 128) throw bad("", "Idempotency-Key header (8-128 chars) is required");
    return tx(this.pool, async (c) => {
      const p = await this.owned(c, req.principal.subject, pid, true);
      if (p.state === "DISCARDED") return toProposal(p);
      if (!OPEN.includes(p.state)) throw new ApiError(409, "INVALID_TRANSITION", [{ code: "INVALID_TRANSITION", pointer: "", message: `proposal is ${p.state}` }]);
      await c.query("UPDATE aurea.ai_proposal SET state = 'DISCARDED' WHERE id = $1", [p.id]);
      return toProposal({ ...p, state: "DISCARDED", expired: false });
    });
  }
}

/**
 * Called by createRevision in the same transaction when the accepted preview came from AURA:
 * the proposal must still be open, on this preview, and not expired. Returns the proposal id.
 */
export async function acceptProposalPreview(c: PoolClient, job: JobRow): Promise<string | null> {
  const op = job.operation as { kind?: string; proposalId?: string } | null;
  if (op?.kind !== "AI_PROPOSAL" || !op.proposalId) return null;
  const { rows } = await c.query<{ state: string; preview_job_id: string | null; expired: boolean }>(
    "SELECT state, preview_job_id, (expires_at <= now()) AS expired FROM aurea.ai_proposal WHERE id = $1 FOR UPDATE", [op.proposalId]);
  const p = rows[0];
  if (!p || p.state !== "PREVIEWING" || p.preview_job_id !== job.id) {
    throw new ApiError(409, "INVALID_TRANSITION", [{ code: "INVALID_TRANSITION", pointer: "/previewJobId", message: "this preview is no longer the proposal's current one" }]);
  }
  if (p.expired) throw new ApiError(409, "PROPOSAL_EXPIRED");
  return op.proposalId;
}

export async function markProposalAccepted(c: PoolClient, proposalId: string, revisionId: string): Promise<void> {
  await c.query("UPDATE aurea.ai_proposal SET state = 'ACCEPTED', revision_id = $2 WHERE id = $1", [proposalId, revisionId]);
}
