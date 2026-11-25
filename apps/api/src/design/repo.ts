import { createHash, randomUUID } from "node:crypto";
import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { canonicalJson, diffParameters, MAIN_BRANCH, type DesignDocument } from "@aurea/design";
import { isUnavailable } from "../database";
import { ApiError } from "./api-error";

export type Source = "CREATE" | "PREVIEW" | "SYNC" | "AI";
export interface RevisionRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  number: number;
  document: DesignDocument;
  digest: string;
  state: string;
  source: Source;
  created_at: string;
}
export interface ProjectRow { id: string; title: string; family_id: string; created_at: string; updated_at: string; head_id: string; head_number: number }

export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
export const canonicalSha = (v: unknown) => sha256(canonicalJson(v));
export const digestOf = canonicalSha;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuidParam(v: string | undefined, pointer: string): string {
  if (!v || !UUID.test(v)) throw new ApiError(400, "VALIDATION_FAILED", [{ code: "VALIDATION_FAILED", pointer, message: "must be a UUID" }]);
  return v.toLowerCase();
}

/** Run `fn` in a transaction; connection failures become 503. */
export async function tx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    if (isUnavailable(err)) throw new ServiceUnavailableException();
    throw err;
  }
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (isUnavailable(err)) throw new ServiceUnavailableException();
    throw err;
  } finally {
    client.release();
  }
}

export const PROJECT_COLUMNS = `p.id, p.title, p.family_id, p.created_at::text, p.updated_at::text, r.id AS head_id, r.number AS head_number`;
const PROJECT_FROM = `aurea.project p JOIN aurea.customer c ON c.id = p.owner_id
  JOIN aurea.branch b ON b.project_id = p.id AND b.name = '${MAIN_BRANCH}' JOIN aurea.revision r ON r.id = b.head_id`;

export function toProject(r: ProjectRow) {
  return {
    id: r.id, title: r.title, familyId: r.family_id, headRevisionId: r.head_id, headRevisionNumber: r.head_number,
    createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
  };
}

/** Scope `own`: a project of another customer is indistinguishable from a missing one (404). */
export async function ownedProject(c: Pool | PoolClient, subject: string, id: string, lock = false): Promise<ProjectRow> {
  const { rows } = await c.query<ProjectRow>(
    `SELECT ${PROJECT_COLUMNS} FROM ${PROJECT_FROM} WHERE p.id = $1 AND c.subject = $2 ${lock ? "FOR UPDATE OF b" : ""}`,
    [id, subject],
  );
  if (!rows[0]) throw new NotFoundException();
  return rows[0];
}

export async function listOwnedProjects(pool: Pool, subject: string, after: [string, string] | null, limit: number) {
  const { rows } = await pool.query<ProjectRow>(
    `SELECT ${PROJECT_COLUMNS} FROM ${PROJECT_FROM} WHERE c.subject = $1
       AND ($2::timestamptz IS NULL OR (p.updated_at, p.id) < ($2::timestamptz, $3::uuid))
     ORDER BY p.updated_at DESC, p.id DESC LIMIT $4`,
    [subject, after?.[0] ?? null, after?.[1] ?? null, limit + 1],
  );
  return rows;
}

const REVISION_COLUMNS = "id, project_id, parent_id, number, document, digest, state, source, created_at::text";

export async function revision(c: Pool | PoolClient, projectId: string, id: string): Promise<RevisionRow> {
  const { rows } = await c.query<RevisionRow>(`SELECT ${REVISION_COLUMNS} FROM aurea.revision WHERE project_id = $1 AND id = $2`, [projectId, id]);
  if (!rows[0]) throw new NotFoundException();
  return rows[0];
}

export async function revisionsPage(pool: Pool, projectId: string, beforeNumber: number | null, limit: number) {
  const { rows } = await pool.query<RevisionRow & { parent_document: DesignDocument | null }>(
    `SELECT r.id, r.project_id, r.parent_id, r.number, r.document, r.digest, r.state, r.source, r.created_at::text,
            p.document AS parent_document
       FROM aurea.revision r LEFT JOIN aurea.revision p ON p.project_id = r.project_id AND p.id = r.parent_id
      WHERE r.project_id = $1 AND ($2::int IS NULL OR r.number < $2) ORDER BY r.number DESC LIMIT $3`,
    [projectId, beforeNumber, limit + 1],
  );
  return rows;
}

export function toRevision(r: RevisionRow) {
  return {
    id: r.id, projectId: r.project_id, parentId: r.parent_id, number: r.number, digest: r.digest,
    document: r.document, state: r.state, createdAt: new Date(r.created_at).toISOString(),
  };
}

export function toRevisionSummary(r: RevisionRow & { parent_document: DesignDocument | null }) {
  return {
    id: r.id, number: r.number, parentId: r.parent_id, digest: r.digest, state: r.state, source: r.source,
    createdAt: new Date(r.created_at).toISOString(),
    changes: r.parent_document ? diffParameters(r.parent_document, r.document).map((d) => ({ ...d, from: d.from ?? null })) : [],
  };
}

/**
 * Append a revision on main. Caller holds the branch row lock (ownedProject(..., lock = true)) and
 * has checked the base. Writes revision, branch head, project timestamp and the RevisionCreated
 * event in the caller's transaction.
 */
export async function appendRevision(
  c: PoolClient,
  args: { project: ProjectRow; document: DesignDocument; actor: string; source: Source; sourceId: string | null; correlationId: string },
): Promise<RevisionRow> {
  const id = randomUUID();
  const number = args.project.head_number + 1;
  const document = { ...args.document, revision: number };
  const digest = digestOf(document);
  const { rows } = await c.query<RevisionRow>(
    `INSERT INTO aurea.revision(id, project_id, parent_id, number, document, digest, created_by, source, source_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${REVISION_COLUMNS}`,
    [id, args.project.id, args.project.head_id, number, document, digest, args.actor, args.source, args.sourceId],
  );
  await c.query(`UPDATE aurea.branch SET head_id = $1 WHERE project_id = $2 AND name = '${MAIN_BRANCH}'`, [id, args.project.id]);
  await c.query("UPDATE aurea.project SET updated_at = now() WHERE id = $1", [args.project.id]);
  await revisionEvent(c, rows[0], args.correlationId);
  return rows[0];
}

export async function revisionEvent(c: PoolClient, r: RevisionRow, correlationId: string): Promise<void> {
  await c.query(
    `INSERT INTO aurea.outbox(id, event_type, schema_version, aggregate_id, aggregate_version, occurred_at, correlation_id, payload)
     VALUES ($1, 'RevisionCreated', 1, $2, $3, now(), $4, $5)`,
    [randomUUID(), r.project_id, r.number, correlationId,
      { projectId: r.project_id, revisionId: r.id, number: r.number, parentId: r.parent_id, digest: r.digest, source: r.source }],
  );
}

/**
 * Idempotency-Key (table `idempotency`): the first request stores its response in the same
 * transaction as its effects; a repeat with the same body gets that response, with another body 409.
 */
export async function idempotent<T>(
  c: PoolClient, actor: string, scope: string, key: string | undefined, body: unknown, fn: () => Promise<T>,
): Promise<T> {
  if (!key || key.length < 8 || key.length > 128) {
    throw new ApiError(400, "VALIDATION_FAILED", [{ code: "VALIDATION_FAILED", pointer: "", message: "Idempotency-Key header (8-128 chars) is required" }]);
  }
  const requestDigest = sha256(canonicalJson(body ?? null));
  const inserted = await c.query(
    `INSERT INTO aurea.idempotency(actor, scope, key, request_digest) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [actor, scope, key, requestDigest],
  );
  if (inserted.rowCount === 0) {
    const { rows } = await c.query<{ request_digest: string; response: T | null }>(
      "SELECT request_digest, response FROM aurea.idempotency WHERE actor=$1 AND scope=$2 AND key=$3", [actor, scope, key]);
    if (rows[0].request_digest !== requestDigest) throw new ApiError(409, "IDEMPOTENCY_CONFLICT");
    if (rows[0].response !== null) return rows[0].response;
  }
  const out = await fn();
  await c.query("UPDATE aurea.idempotency SET response = $4 WHERE actor=$1 AND scope=$2 AND key=$3", [actor, scope, key, JSON.stringify(out)]);
  return out;
}

export async function ensureCustomer(c: PoolClient, subject: string): Promise<string> {
  await c.query("INSERT INTO aurea.customer(id, subject) VALUES ($1, $2) ON CONFLICT (subject) DO NOTHING", [randomUUID(), subject]);
  const { rows } = await c.query<{ id: string }>("SELECT id FROM aurea.customer WHERE subject = $1", [subject]);
  return rows[0].id;
}

export function encodeCursor(parts: (string | number)[]): string {
  return Buffer.from(JSON.stringify(parts)).toString("base64url");
}

export function decodeCursor(cursor: string | undefined): unknown[] | null {
  if (!cursor) return null;
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(v)) return v;
  } catch {
    /* fall through */
  }
  throw new ApiError(400, "VALIDATION_FAILED", [{ code: "VALIDATION_FAILED", pointer: "/cursor", message: "invalid cursor" }]);
}
