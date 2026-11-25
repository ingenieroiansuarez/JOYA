import { Body, Controller, Get, Headers, HttpCode, Inject, Post, Query, Req } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { applyOperation, canRebase, diffParameters, MAIN_BRANCH, type DesignOperation } from "@aurea/design";
import { DATABASE } from "../database";
import { correlationId } from "../errors.filter";
import { RequirePermission } from "../identity/permission.decorator";
import type { Principal } from "../identity/principal";
import { ApiError } from "./api-error";
import { appendRevision, canonicalSha, decodeCursor, encodeCursor, ownedProject, revision, tx } from "./repo";

interface AuthedRequest { principal: Principal; header(name: string): string | undefined }
interface SyncOp { id: string; projectId: string; branch: string; baseRevisionId: string; sequence: number; createdAt: string; operation: DesignOperation }
type Result =
  | { operationId: string; status: "APPLIED"; revisionId: string }
  | { operationId: string; status: "CONFLICT"; serverRevisionId: string; error: { code: string; message: string } }
  | { operationId: string; status: "REJECTED"; error: { code: string; pointer?: string; message: string } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OP_KEYS = ["id", "projectId", "branch", "baseRevisionId", "sequence", "createdAt", "operation"];
const PULL_LIMIT = 100;

function wellFormed(op: unknown): op is SyncOp {
  if (!op || typeof op !== "object") return false;
  const o = op as Record<string, unknown>;
  return Object.keys(o).every((k) => OP_KEYS.includes(k)) && OP_KEYS.every((k) => k in o)
    && [o.id, o.projectId, o.baseRevisionId].every((v) => typeof v === "string" && UUID.test(v))
    && typeof o.branch === "string" && Number.isInteger(o.sequence) && (o.sequence as number) >= 1
    && typeof o.createdAt === "string" && !Number.isNaN(Date.parse(o.createdAt))
    && !!o.operation && typeof o.operation === "object";
}

/** OpenAPI syncPush / syncPull (22_OFFLINE_AND_SYNC/SYNC.md). */
@Controller("sync")
export class SyncController {
  constructor(@Inject(DATABASE) private readonly pool: Pool) {}

  @Post("push")
  @HttpCode(200)
  @RequirePermission("sync.write")
  async push(@Req() req: AuthedRequest, @Body() raw: { deviceId?: string; operations?: unknown[] }, @Headers("idempotency-key") key?: string) {
    if (!key || key.length < 8 || key.length > 128) throw new ApiError(400, "VALIDATION_FAILED", [{ code: "VALIDATION_FAILED", pointer: "", message: "Idempotency-Key header is required" }]);
    if (!raw || typeof raw.deviceId !== "string" || !UUID.test(raw.deviceId) || !Array.isArray(raw.operations)
      || raw.operations.length < 1 || raw.operations.length > 200 || Object.keys(raw).some((k) => k !== "deviceId" && k !== "operations")) {
      throw new ApiError(400, "VALIDATION_FAILED", [{ code: "VALIDATION_FAILED", pointer: "", message: "deviceId and 1-200 operations are required" }]);
    }
    if (!raw.operations.every(wellFormed)) throw new ApiError(400, "VALIDATION_FAILED", [{ code: "VALIDATION_FAILED", pointer: "/operations", message: "malformed SyncOperation" }]);
    const ops = raw.operations as SyncOp[];
    const subject = req.principal.subject;
    const blocked = new Set<string>(); // projects whose earlier operation did not apply: keep the order
    const results: Result[] = [];
    for (const op of ops) {
      const r = await tx(this.pool, (c) => this.one(c, subject, raw.deviceId!, op, blocked.has(op.projectId), correlationId(req)));
      if (r.status !== "APPLIED") blocked.add(op.projectId);
      results.push(r);
    }
    return { results, cursor: await this.headCursor(subject) };
  }

  private async one(c: PoolClient, subject: string, deviceId: string, op: SyncOp, blocked: boolean, corr: string): Promise<Result> {
    const bodyDigest = canonicalSha(op);
    const prior = await c.query<{ actor: string; body_digest: string; result: Result }>(
      "SELECT actor, body_digest, result FROM aurea.sync_operation WHERE id = $1", [op.id]);
    if (prior.rows[0]) {
      const p = prior.rows[0];
      if (p.actor === subject && p.body_digest === bodyDigest) return p.result;
      return { operationId: op.id, status: "REJECTED", error: { code: "IDEMPOTENCY_CONFLICT", message: "operation id already used with another body" } };
    }
    let project;
    try {
      project = await ownedProject(c, subject, op.projectId, true);
    } catch {
      return { operationId: op.id, status: "REJECTED", error: { code: "NOT_FOUND", pointer: "/projectId", message: "project not found" } };
    }
    if (op.branch !== MAIN_BRANCH) {
      return { operationId: op.id, status: "REJECTED", error: { code: "INVALID_REQUEST", pointer: "/branch", message: "only main is synchronized in hito 300" } };
    }
    // Not stored: once the earlier operation is resolved the client may resend this one.
    if (blocked) return { operationId: op.id, status: "CONFLICT", serverRevisionId: project.head_id, error: { code: "VERSION_CONFLICT", message: "an earlier operation of this project did not apply" } };
    const store = async (r: Result) => {
      await c.query("INSERT INTO aurea.sync_operation(id, actor, device_id, project_id, body_digest, status, result) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [op.id, subject, deviceId, project.id, bodyDigest, r.status, JSON.stringify(r)]);
      return r;
    };
    let base;
    try {
      base = await revision(c, project.id, op.baseRevisionId);
    } catch {
      return store({ operationId: op.id, status: "REJECTED", error: { code: "NOT_FOUND", pointer: "/baseRevisionId", message: "base revision not found" } });
    }
    const head = base.id === project.head_id ? base : await revision(c, project.id, project.head_id);
    if (base.id !== head.id) {
      // Independent parameters only: what changed between base and head must not touch what this op writes.
      const since = diffParameters(base.document, head.document).map((d) =>
        d.name === "materialId"
          ? { type: "change_material", componentId: d.componentId, materialId: String(d.to) }
          : { type: "modify_parameter", componentId: d.componentId, name: d.name, value: Number(d.to) });
      if (!canRebase(op.operation, since as DesignOperation[])) {
        return store({ operationId: op.id, status: "CONFLICT", serverRevisionId: head.id, error: { code: "VERSION_CONFLICT", message: "the same value changed on the server" } });
      }
    }
    const applied = applyOperation(head.document, op.operation);
    if (!applied.ok) {
      const i = applied.issues[0];
      return store({ operationId: op.id, status: "REJECTED", error: { code: i.code, pointer: i.path, message: i.message } });
    }
    if (canonicalSha({ ...applied.document, revision: head.number }) === head.digest) {
      return store({ operationId: op.id, status: "APPLIED", revisionId: head.id }); // already so: nothing to add
    }
    const created = await appendRevision(c, { project, document: applied.document, actor: subject, source: "SYNC", sourceId: op.id, correlationId: corr });
    return store({ operationId: op.id, status: "APPLIED", revisionId: created.id });
  }

  /**
   * Position of the caller's latest visible event. Informational: a client keeps its own pull
   * cursor (events from its other devices may sit before this one).
   */
  private async headCursor(subject: string): Promise<string> {
    const { rows } = await this.pool.query<{ tx: string; seq: string }>(
      `SELECT o.tx::text, o.seq::text FROM aurea.outbox o JOIN aurea.project p ON p.id = o.aggregate_id
         JOIN aurea.customer c ON c.id = p.owner_id
        WHERE c.subject = $1 AND o.tx < pg_snapshot_xmin(pg_current_snapshot()) ORDER BY o.tx DESC, o.seq DESC LIMIT 1`, [subject]);
    return rows[0] ? encodeCursor([rows[0].tx, rows[0].seq]) : encodeCursor(["0", "0"]);
  }

  /** Events of the caller's projects in commit order; only below the oldest running transaction. */
  @Get("pull")
  @RequirePermission("sync.read")
  async pull(@Req() req: AuthedRequest, @Query("cursor") cursor?: string) {
    const [tx0, seq0] = (decodeCursor(cursor) ?? ["0", "0"]).map(String);
    if (!/^\d+$/.test(tx0) || !/^\d+$/.test(seq0)) throw new ApiError(400, "VALIDATION_FAILED");
    const { rows } = await this.pool.query<{
      id: string; event_type: string; schema_version: number; aggregate_id: string; aggregate_version: number;
      occurred_at: string; correlation_id: string; causation_id: string | null; payload: object; tx: string; seq: string;
    }>(
      `SELECT o.id, o.event_type, o.schema_version, o.aggregate_id, o.aggregate_version, o.occurred_at::text, o.correlation_id,
              o.causation_id, o.payload, o.tx::text, o.seq::text
         FROM aurea.outbox o JOIN aurea.project p ON p.id = o.aggregate_id JOIN aurea.customer c ON c.id = p.owner_id
        WHERE c.subject = $1 AND (o.tx, o.seq) > ($2::xid8, $3::bigint) AND o.tx < pg_snapshot_xmin(pg_current_snapshot())
        ORDER BY o.tx, o.seq LIMIT ${PULL_LIMIT}`,
      [req.principal.subject, tx0, seq0]);
    const last = rows[rows.length - 1];
    return {
      events: rows.map((e) => ({
        eventId: e.id, eventType: e.event_type, schemaVersion: e.schema_version, aggregateId: e.aggregate_id,
        aggregateVersion: e.aggregate_version, occurredAt: new Date(e.occurred_at).toISOString(), correlationId: e.correlation_id,
        causationId: e.causation_id, payload: e.payload,
      })),
      cursor: last ? encodeCursor([last.tx, last.seq]) : encodeCursor([tx0, seq0]),
    };
  }
}
