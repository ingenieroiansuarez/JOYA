// Test doubles for the design layer: a node:sqlite shim with expo-sqlite's async API (so the real SQL
// of SqliteDesignStore runs), and an in-memory server that follows the API's sync rules.
import { applyOperation, canRebase, newDocument, type DesignDocument, type DesignOperation } from "@aurea/design";
import { ApiError } from "../src/api";
import type { SqlDb } from "../src/design/store";
import type { Job, Project, Revision, SyncOperation, SyncOperationResult, SyncResult } from "../src/design/types";

const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => {
  exec(sql: string): void; prepare(sql: string): { run(...p: unknown[]): unknown; all(...p: unknown[]): unknown[]; get(...p: unknown[]): unknown };
  close(): void;
} };

/** A file-backed database, so a "restart" can open the same file again. */
export function sqlite(path = ":memory:"): SqlDb & { close(): void } {
  const db = new DatabaseSync(path);
  return {
    async execAsync(sql) { db.exec(sql); },
    async runAsync(sql, params) { return db.prepare(sql).run(...params); },
    async getAllAsync<T>(sql: string, params: (string | number | null)[]) { return db.prepare(sql).all(...params) as T[]; },
    async getFirstAsync<T>(sql: string, params: (string | number | null)[]) { return (db.prepare(sql).get(...params) as T | undefined) ?? null; },
    close() { db.close(); },
  };
}

let n = 0;
export const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

interface Rev { revision: Revision; ops: DesignOperation[] }

/** Server side of projects and sync, with the same rules as apps/api (rebase over independent keys only). */
export class FakeDesignServer {
  online = true;
  projects = new Map<string, { project: Project; revisions: Rev[] }>();
  stored = new Map<string, { body: string; result: SyncOperationResult }>();
  pushes: SyncOperation[][] = [];
  /** Answer lost after applying (the client saw a network error). */
  dropNextAnswer = false;

  create(familyId = "ring.02", materialId = "gold-18k-yellow"): Project {
    const id = uuid();
    const made = newDocument({ projectId: id, familyId, materialId });
    if (!made.ok) throw new Error("fixture");
    const revision: Revision = { id: uuid(), projectId: id, number: 1, digest: "a".repeat(64), document: made.document, parentId: null, createdAt: "2026-11-25T00:00:00Z" };
    const project: Project = { id, title: "Anillo", familyId, headRevisionId: revision.id, headRevisionNumber: 1, createdAt: revision.createdAt, updatedAt: revision.createdAt };
    this.projects.set(id, { project, revisions: [{ revision, ops: [] }] });
    return project;
  }

  /** A change made on the server (another device or an accepted preview). */
  change(projectId: string, op: DesignOperation): Revision {
    const p = this.projects.get(projectId)!;
    const head = p.revisions[p.revisions.length - 1].revision;
    const r = applyOperation(head.document, op);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    return this.append(projectId, r.document, op);
  }

  private append(projectId: string, document: DesignDocument, op: DesignOperation): Revision {
    const p = this.projects.get(projectId)!;
    const head = p.revisions[p.revisions.length - 1].revision;
    const revision: Revision = { id: uuid(), projectId, number: head.number + 1, digest: String(head.number + 1).padStart(64, "0"),
      document: { ...document, revision: head.number + 1 }, parentId: head.id, createdAt: "2026-11-25T00:00:01Z" };
    p.revisions.push({ revision, ops: [op] });
    p.project = { ...p.project, headRevisionId: revision.id, headRevisionNumber: revision.number };
    return revision;
  }

  head(projectId: string): Revision {
    const p = this.projects.get(projectId)!;
    return p.revisions[p.revisions.length - 1].revision;
  }

  private gate() {
    if (!this.online) throw new ApiError("offline");
  }

  client() {
    const self = this;
    return {
      async getProject(id: string) { self.gate(); const p = self.projects.get(id); if (!p) throw new ApiError("notFound", 404); return p.project; },
      async getRevision(projectId: string, revisionId: string) {
        self.gate();
        const r = self.projects.get(projectId)?.revisions.find((x) => x.revision.id === revisionId);
        if (!r) throw new ApiError("notFound", 404);
        return r.revision;
      },
      async listProjects() { self.gate(); return { items: [...self.projects.values()].map((p) => p.project), nextCursor: null }; },
      async push(_device: string, ops: SyncOperation[]): Promise<SyncResult> {
        self.gate();
        self.pushes.push(ops);
        const results = ops.map((op) => self.apply(op));
        if (self.dropNextAnswer) { self.dropNextAnswer = false; throw new ApiError("offline"); }
        return { results, cursor: "c" };
      },
    } as unknown as import("../src/design/client").DesignClient & { getJob?(id: string): Promise<Job> };
  }

  private apply(op: SyncOperation): SyncOperationResult {
    const body = JSON.stringify(op);
    const prior = this.stored.get(op.id);
    if (prior) return prior.body === body ? prior.result : { operationId: op.id, status: "REJECTED", error: { code: "IDEMPOTENCY_CONFLICT", message: "" } };
    const p = this.projects.get(op.projectId);
    const store = (result: SyncOperationResult) => { this.stored.set(op.id, { body, result }); return result; };
    if (!p) return { operationId: op.id, status: "REJECTED", error: { code: "NOT_FOUND", message: "" } };
    const baseIdx = p.revisions.findIndex((r) => r.revision.id === op.baseRevisionId);
    if (baseIdx < 0) return store({ operationId: op.id, status: "REJECTED", error: { code: "NOT_FOUND", message: "" } });
    const head = p.revisions[p.revisions.length - 1].revision;
    const since = p.revisions.slice(baseIdx + 1).flatMap((r) => r.ops);
    if (since.length && !canRebase(op.operation, since)) {
      return store({ operationId: op.id, status: "CONFLICT", serverRevisionId: head.id, error: { code: "VERSION_CONFLICT", message: "" } });
    }
    const r = applyOperation(head.document, op.operation);
    if (!r.ok) return store({ operationId: op.id, status: "REJECTED", error: { code: r.issues[0].code, message: r.issues[0].message } });
    return store({ operationId: op.id, status: "APPLIED", revisionId: this.append(op.projectId, r.document, op.operation).id });
  }
}

// ---- HTTP-level fake for screen tests: Api.send routed to FakeDesignServer, plus preview jobs.
import { createHash } from "node:crypto";
import { Api } from "../src/api";
import type { ProductPage } from "../src/api";

export const GLB_BYTES = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]);
export const GLB_SHA = createHash("sha256").update(GLB_BYTES).digest("hex");
/** A preview's mesh differs from the head's, so a test can tell which one was cached. */
export const PREVIEW_BYTES = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 1]);
export const PREVIEW_SHA = createHash("sha256").update(PREVIEW_BYTES).digest("hex");

export class DesignApi extends Api {
  jobs = new Map<string, Job>();
  calls: string[] = [];
  /** Idempotency-Key → revision, as apps/api answers a repeated acceptance. */
  accepted = new Map<string, Revision>();
  /** The next acceptance is committed but its answer is lost. */
  dropNextAccept = false;
  constructor(readonly server: FakeDesignServer) {
    super({ env: "ci", issuer: "http://127.0.0.1:8080/realms/aurea-local", apiUrl: "http://127.0.0.1:3000" }, "en");
  }
  async listProducts(): Promise<ProductPage> { return { items: [], nextCursor: null }; }
  async listFavorites(): Promise<ProductPage> { return { items: [], nextCursor: null }; }

  private job(projectId: string, revisionId: string, kind: string, document: DesignDocument | null, base: DesignDocument | null): Job {
    const comp = document?.components[0];
    const job: Job = {
      id: uuid(), kind, state: "SUCCEEDED", projectId, revisionId, simulated: false, errorCode: null,
      artifacts: [{ id: uuid(), kind: "GLB_PREVIEW", units: "m", sha256: kind === "PREVIEW" ? PREVIEW_SHA : GLB_SHA, bytes: GLB_BYTES.length, name: "ring-base.glb" }],
      summary: comp && base ? {
        document: document!, changes: diffParametersOf(base, document!), dfmState: "REVIEW", humanApprovalRequired: true, engineVersion: "fake", status: "POC",
        components: [{ id: comp.id, family: comp.family, materialId: comp.materialId, volumeMm3: "481.795", massGramsEstimate: "7.468",
          densityStatus: "NOMINAL_UNCONFIRMED", boundingBoxMm: [23.1, 23.1, 4], minWallMm: 1.8 }],
      } : null,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  async send<T>(method: string, path: string, opts: { body?: unknown; idempotencyKey?: string } = {}): Promise<T | undefined> {
    this.calls.push(`${method} ${path}`);
    const s = this.server;
    const c = s.client() as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    if (!s.online) throw new ApiError("offline");
    const body = opts.body as Record<string, unknown> | undefined;
    let m: RegExpExecArray | null;
    if (method === "GET" && path.startsWith("/projects?") || path === "/projects" && method === "GET") return c.listProjects() as Promise<T>;
    if ((m = /^\/projects\/([^/]+)$/.exec(path))) return c.getProject(m[1]) as Promise<T>;
    if (method === "GET" && (m = /^\/projects\/([^/]+)\/revisions\/([^/]+)$/.exec(path))) return c.getRevision(m[1], m[2]) as Promise<T>;
    if (method === "POST" && path === "/projects") {
      const p = s.create(String(body!.templateId), String(body!.materialId));
      s.projects.get(p.id)!.project.title = String(body!.title);
      return s.projects.get(p.id)!.project as T;
    }
    if (method === "POST" && (m = /^\/projects\/([^/]+)\/operations$/.exec(path))) {
      const head = s.head(m[1]);
      if (body!.baseRevisionId !== head.id) throw new ApiError("conflict", 409, "VERSION_CONFLICT");
      const r = applyOperation(head.document, body!.operation as DesignOperation);
      if (!r.ok) throw new ApiError("rejected", 422, "INVALID_DOCUMENT", r.issues.map((i) => ({ code: i.code, pointer: i.path, message: i.message })));
      const job = this.job(m[1], head.id, "PREVIEW", r.document, head.document);
      (job as Job & { op?: unknown }).op = body!.operation;
      return job as T;
    }
    if (method === "POST" && (m = /^\/projects\/([^/]+)\/revisions$/.exec(path))) {
      const prior = opts.idempotencyKey ? this.accepted.get(opts.idempotencyKey) : undefined;
      if (prior) return prior as T;
      const head = s.head(m[1]);
      if (body!.baseRevisionId !== head.id) throw new ApiError("conflict", 409, "VERSION_CONFLICT");
      const job = this.jobs.get(String(body!.previewJobId)) as Job & { op: DesignOperation };
      const rev = s.change(m[1], job.op);
      if (opts.idempotencyKey) this.accepted.set(opts.idempotencyKey, rev);
      if (this.dropNextAccept) { this.dropNextAccept = false; throw new ApiError("offline"); }
      return rev as T;
    }
    if (method === "POST" && path === "/geometry/jobs") {
      for (const [pid, p] of s.projects) {
        const rev = p.revisions.find((r) => r.revision.id === body!.revisionId);
        if (rev) return this.job(pid, rev.revision.id, "GEOMETRY", null, null) as T;
      }
      throw new ApiError("notFound", 404);
    }
    if ((m = /^\/jobs\/([^/]+)$/.exec(path))) return this.jobs.get(m[1]) as T;
    if ((m = /^\/jobs\/([^/]+)\/artifacts\/([^/]+)$/.exec(path))) {
      const sha = this.jobs.get(m[1])!.artifacts[0].sha256;
      return { url: `http://files.test/${sha}`, expiresAt: "", sha256: sha } as T;
    }
    if (method === "POST" && path === "/sync/push") return c.push(body!.deviceId, body!.operations) as Promise<T>;
    throw new Error(`unrouted ${method} ${path}`);
  }
}

function diffParametersOf(before: DesignDocument, after: DesignDocument) {
  const out: { componentId: string; name: string; from: number | string | boolean | null; to: number | string | boolean }[] = [];
  const [a, b] = [before.components[0], after.components[0]];
  for (const [k, v] of Object.entries(b.parameters)) if (a.parameters[k] !== v) out.push({ componentId: b.id, name: k, from: a.parameters[k], to: v });
  if (a.materialId !== b.materialId) out.push({ componentId: b.id, name: "materialId", from: a.materialId, to: b.materialId });
  return out;
}
