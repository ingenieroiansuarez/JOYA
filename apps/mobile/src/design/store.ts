// What the app keeps on the phone for designs: the last known head of each project (so editing works
// offline and after a restart), the outbox of offline operations with their base revision (SYNC.md:
// persisted, ordered, never last-write-wins), the last preview mesh per revision digest and one
// picture per project taken from the 3D viewer for the designs list.
// Everything is scoped to the signed-in customer: another account on the same phone sees none of it,
// and signing out keeps unsent work for when the same customer signs in again.
import type { Project, Revision, SyncOperation } from "./types";

export type OutboxStatus = "PENDING" | "CONFLICT" | "REJECTED";
export interface OutboxEntry {
  op: SyncOperation;
  status: OutboxStatus;
  /** Set when the server answered CONFLICT or REJECTED. */
  error?: { code: string; message: string };
  serverRevisionId?: string;
}
export interface LocalProject { project: Project; head: Revision }

export interface DesignStore {
  projects(): Promise<LocalProject[]>;
  project(id: string): Promise<LocalProject | null>;
  putProject(p: LocalProject): Promise<void>;
  /** Ordered by sequence. */
  outbox(projectId?: string): Promise<OutboxEntry[]>;
  enqueue(op: SyncOperation): Promise<void>;
  mark(id: string, status: OutboxStatus, extra?: { error?: OutboxEntry["error"]; serverRevisionId?: string }): Promise<void>;
  remove(id: string): Promise<void>;
  /** Only for an operation that was never sent: its body is not yet known to the server. */
  setBase(id: string, baseRevisionId: string): Promise<void>;
  nextSequence(): Promise<number>;
  deviceId(make: () => string): Promise<string>;
  glb(digest: string): Promise<string | null>;
  putGlb(digest: string, base64: string): Promise<void>;
  /** Picture of a project's design taken from the 3D viewer, with the revision it shows. */
  thumb(projectId: string): Promise<{ revisionId: string; jpeg: string } | null>;
  putThumb(projectId: string, revisionId: string, jpeg: string): Promise<void>;
}

/** Subset of expo-sqlite's SQLiteDatabase this store uses (also met by a node:sqlite shim in tests). */
export interface SqlDb {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, params: (string | number | null)[]): Promise<unknown>;
  getAllAsync<T>(sql: string, params: (string | number | null)[]): Promise<T[]>;
  getFirstAsync<T>(sql: string, params: (string | number | null)[]): Promise<T | null>;
}

export const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS design_project (owner TEXT NOT NULL, id TEXT NOT NULL, project TEXT NOT NULL, head TEXT NOT NULL,
  PRIMARY KEY (owner, id));
CREATE TABLE IF NOT EXISTS design_outbox (owner TEXT NOT NULL, id TEXT NOT NULL, project_id TEXT NOT NULL, sequence INTEGER NOT NULL,
  op TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('PENDING','CONFLICT','REJECTED')), error TEXT, server_revision_id TEXT,
  PRIMARY KEY (owner, id), UNIQUE (owner, sequence));
CREATE TABLE IF NOT EXISTS design_meta (owner TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (owner, key));
CREATE TABLE IF NOT EXISTS design_glb (owner TEXT NOT NULL, digest TEXT NOT NULL, data TEXT NOT NULL, stored_at INTEGER NOT NULL,
  PRIMARY KEY (owner, digest));
CREATE TABLE IF NOT EXISTS design_thumb (owner TEXT NOT NULL, project_id TEXT NOT NULL, revision_id TEXT NOT NULL, jpeg TEXT NOT NULL,
  PRIMARY KEY (owner, project_id));
`;
/** Preview meshes kept per customer; older ones are dropped (they can be rebuilt online). */
export const GLB_KEEP = 12;

type Row = { op: string; status: OutboxStatus; error: string | null; server_revision_id: string | null };
const entry = (r: Row): OutboxEntry => ({
  op: JSON.parse(r.op) as SyncOperation,
  status: r.status,
  ...(r.error ? { error: JSON.parse(r.error) as OutboxEntry["error"] } : {}),
  ...(r.server_revision_id ? { serverRevisionId: r.server_revision_id } : {}),
});

export class SqliteDesignStore implements DesignStore {
  private constructor(private readonly db: SqlDb, private readonly owner: string) {}

  static async open(db: SqlDb, owner: string): Promise<SqliteDesignStore> {
    await db.execAsync(SCHEMA);
    return new SqliteDesignStore(db, owner);
  }

  async projects() {
    const rows = await this.db.getAllAsync<{ project: string; head: string }>(
      "SELECT project, head FROM design_project WHERE owner = ?", [this.owner]);
    return rows.map((r) => ({ project: JSON.parse(r.project) as Project, head: JSON.parse(r.head) as Revision }))
      .sort((a, b) => (a.project.updatedAt < b.project.updatedAt ? 1 : -1));
  }
  async project(id: string) {
    const r = await this.db.getFirstAsync<{ project: string; head: string }>(
      "SELECT project, head FROM design_project WHERE owner = ? AND id = ?", [this.owner, id]);
    return r ? { project: JSON.parse(r.project) as Project, head: JSON.parse(r.head) as Revision } : null;
  }
  async putProject(p: LocalProject) {
    await this.db.runAsync(
      `INSERT INTO design_project(owner, id, project, head) VALUES (?, ?, ?, ?)
       ON CONFLICT(owner, id) DO UPDATE SET project = excluded.project, head = excluded.head`,
      [this.owner, p.project.id, JSON.stringify(p.project), JSON.stringify(p.head)]);
  }
  async outbox(projectId?: string) {
    const rows = await this.db.getAllAsync<Row>(
      `SELECT op, status, error, server_revision_id FROM design_outbox WHERE owner = ? ${projectId ? "AND project_id = ?" : ""} ORDER BY sequence`,
      projectId ? [this.owner, projectId] : [this.owner]);
    return rows.map(entry);
  }
  async enqueue(op: SyncOperation) {
    await this.db.runAsync(
      "INSERT INTO design_outbox(owner, id, project_id, sequence, op, status) VALUES (?, ?, ?, ?, ?, 'PENDING')",
      [this.owner, op.id, op.projectId, op.sequence, JSON.stringify(op)]);
  }
  async mark(id: string, status: OutboxStatus, extra: { error?: OutboxEntry["error"]; serverRevisionId?: string } = {}) {
    await this.db.runAsync(
      "UPDATE design_outbox SET status = ?, error = ?, server_revision_id = ? WHERE owner = ? AND id = ?",
      [status, extra.error ? JSON.stringify(extra.error) : null, extra.serverRevisionId ?? null, this.owner, id]);
  }
  async remove(id: string) {
    await this.db.runAsync("DELETE FROM design_outbox WHERE owner = ? AND id = ?", [this.owner, id]);
  }
  async setBase(id: string, baseRevisionId: string) {
    const r = await this.db.getFirstAsync<{ op: string }>("SELECT op FROM design_outbox WHERE owner = ? AND id = ?", [this.owner, id]);
    if (!r) return;
    const op = { ...(JSON.parse(r.op) as SyncOperation), baseRevisionId };
    await this.db.runAsync("UPDATE design_outbox SET op = ? WHERE owner = ? AND id = ?", [JSON.stringify(op), this.owner, id]);
  }
  async nextSequence() {
    // Kept in meta so a sequence is never reused after its operation left the outbox.
    const r = await this.db.getFirstAsync<{ value: string }>("SELECT value FROM design_meta WHERE owner = ? AND key = 'sequence'", [this.owner]);
    const next = (r ? Number(r.value) : 0) + 1;
    await this.db.runAsync(
      `INSERT INTO design_meta(owner, key, value) VALUES (?, 'sequence', ?)
       ON CONFLICT(owner, key) DO UPDATE SET value = excluded.value`, [this.owner, String(next)]);
    return next;
  }
  async deviceId(make: () => string) {
    const r = await this.db.getFirstAsync<{ value: string }>("SELECT value FROM design_meta WHERE owner = ? AND key = 'device'", [this.owner]);
    if (r) return r.value;
    const id = make();
    await this.db.runAsync("INSERT INTO design_meta(owner, key, value) VALUES (?, 'device', ?)", [this.owner, id]);
    return id;
  }
  async glb(digest: string) {
    const r = await this.db.getFirstAsync<{ data: string }>("SELECT data FROM design_glb WHERE owner = ? AND digest = ?", [this.owner, digest]);
    return r?.data ?? null;
  }
  async putGlb(digest: string, base64: string) {
    await this.db.runAsync(
      `INSERT INTO design_glb(owner, digest, data, stored_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(owner, digest) DO UPDATE SET data = excluded.data, stored_at = excluded.stored_at`,
      [this.owner, digest, base64, Date.now()]);
    await this.db.runAsync(
      `DELETE FROM design_glb WHERE owner = ? AND digest NOT IN
         (SELECT digest FROM design_glb WHERE owner = ? ORDER BY stored_at DESC LIMIT ${GLB_KEEP})`, [this.owner, this.owner]);
  }
  async thumb(projectId: string) {
    const r = await this.db.getFirstAsync<{ revision_id: string; jpeg: string }>(
      "SELECT revision_id, jpeg FROM design_thumb WHERE owner = ? AND project_id = ?", [this.owner, projectId]);
    return r ? { revisionId: r.revision_id, jpeg: r.jpeg } : null;
  }
  async putThumb(projectId: string, revisionId: string, jpeg: string) {
    await this.db.runAsync(
      `INSERT INTO design_thumb(owner, project_id, revision_id, jpeg) VALUES (?, ?, ?, ?)
       ON CONFLICT(owner, project_id) DO UPDATE SET revision_id = excluded.revision_id, jpeg = excluded.jpeg`,
      [this.owner, projectId, revisionId, jpeg]);
  }
}
