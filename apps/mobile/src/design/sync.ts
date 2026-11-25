// Offline design operations (22_OFFLINE_AND_SYNC/SYNC.md). An operation made without connection is
// validated against the local draft, stored with its base revision, and sent later, one at a time and
// in order. The server rebases only over independent values; a conflict or a rejection stays visible
// until the person decides. Nothing is merged silently and nothing is last-write-wins.
import { applyOperation, MAIN_BRANCH, type Issue } from "@aurea/design";
import { ApiError } from "../api";
import type { DesignClient } from "./client";
import type { DesignStore, LocalProject, OutboxEntry } from "./store";
import type { DesignDocument, DesignOperation, SyncOperation } from "./types";

export interface Draft {
  local: LocalProject;
  /** Head with this phone's pending operations applied, as the person last saw it. */
  document: DesignDocument;
  pending: OutboxEntry[];
  /** Waiting for the person: CONFLICT or REJECTED. */
  problems: OutboxEntry[];
}

export type FlushOutcome =
  | { state: "idle" }
  | { state: "offline" }
  | { state: "signedOut" }
  | { state: "done"; applied: number; conflicts: number; rejected: number }
  | { state: "failed" };

export class DesignSync {
  private flushing: Promise<FlushOutcome> | null = null;

  constructor(
    private readonly store: DesignStore,
    private readonly client: DesignClient,
    private readonly newId: () => string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async draft(projectId: string): Promise<Draft | null> {
    const local = await this.store.project(projectId);
    if (!local) return null;
    const entries = await this.store.outbox(projectId);
    const pending = entries.filter((e) => e.status === "PENDING");
    let document = local.head.document;
    for (const e of pending) {
      const r = applyOperation(document, e.op.operation);
      if (r.ok) document = r.document; // an op that no longer applies is reported by the server on send
    }
    return { local, document, pending, problems: entries.filter((e) => e.status !== "PENDING") };
  }

  /** Validates against the draft (same rules as the server) and stores it; invalid input is never queued. */
  async saveOffline(projectId: string, operation: DesignOperation): Promise<{ ok: true } | { ok: false; issues: Issue[] }> {
    const d = await this.draft(projectId);
    if (!d) return { ok: false, issues: [{ code: "NOT_FOUND", path: "/projectId", message: projectId }] };
    const r = applyOperation(d.document, operation);
    if (!r.ok) return r;
    const op: SyncOperation = {
      id: this.newId(), projectId, branch: MAIN_BRANCH, baseRevisionId: d.local.head.id,
      sequence: await this.store.nextSequence(), createdAt: this.now().toISOString(), operation,
    };
    await this.store.enqueue(op);
    return { ok: true };
  }

  async discard(operationId: string): Promise<void> {
    await this.store.remove(operationId);
  }

  /**
   * Resolve a conflict by making the same change again on the server's current head (a new
   * operation, so the stored conflict stays as it was). Later pending operations move onto that head.
   */
  async retryOnLatest(operationId: string): Promise<{ ok: true } | { ok: false; issues: Issue[] }> {
    const entry = (await this.store.outbox()).find((e) => e.op.id === operationId);
    if (!entry) return { ok: true };
    await this.refresh(entry.op.projectId);
    const local = await this.store.project(entry.op.projectId);
    if (!local) return { ok: false, issues: [{ code: "NOT_FOUND", path: "/projectId", message: entry.op.projectId }] };
    const check = applyOperation(local.head.document, entry.op.operation);
    if (!check.ok) return check;
    await this.store.remove(operationId);
    for (const e of await this.store.outbox(entry.op.projectId)) {
      if (e.status === "PENDING") await this.store.setBase(e.op.id, local.head.id);
    }
    // Same place in the queue: the changes waiting behind it were made on top of it.
    const op: SyncOperation = { ...entry.op, id: this.newId(), baseRevisionId: local.head.id, sequence: entry.op.sequence, createdAt: this.now().toISOString() };
    await this.store.enqueue(op);
    return { ok: true };
  }

  /** Server head of one project into the local copy. */
  async refresh(projectId: string): Promise<LocalProject> {
    const project = await this.client.getProject(projectId);
    const local = await this.store.project(projectId);
    const head = local?.head.id === project.headRevisionId ? local.head : await this.client.getRevision(projectId, project.headRevisionId);
    const next = { project, head };
    await this.store.putProject(next);
    return next;
  }

  /** Send pending operations in order; one in flight at a time across the app. */
  flush(): Promise<FlushOutcome> {
    this.flushing ??= this.run().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  private async run(): Promise<FlushOutcome> {
    const report = { applied: 0, conflicts: 0, rejected: 0 };
    const blocked = new Set<string>(); // projects with an unresolved problem keep their order
    let sent = 0;
    for (;;) {
      const entries = await this.store.outbox();
      for (const e of entries) if (e.status !== "PENDING") blocked.add(e.op.projectId);
      const next = entries.find((e) => e.status === "PENDING" && !blocked.has(e.op.projectId));
      if (!next) return sent === 0 && report.applied === 0 ? { state: "idle" } : { state: "done", ...report };
      sent++;
      let result;
      try {
        const deviceId = await this.store.deviceId(this.newId);
        result = (await this.client.push(deviceId, [next.op], this.newId())).results[0];
      } catch (e) {
        if (e instanceof ApiError && e.kind === "offline") return { state: "offline" };
        if (e instanceof ApiError && e.kind === "unauthenticated") return { state: "signedOut" };
        return { state: "failed" }; // stays PENDING; the same id is resent later and deduplicated
      }
      if (!result || result.operationId !== next.op.id) return { state: "failed" };
      if (result.status === "APPLIED") {
        await this.store.remove(next.op.id);
        // Operations made after this one were made on top of it. They move onto its revision only when
        // the server applied it directly on its base: if it was rebased, that revision also holds
        // other devices' writes, and moving past them would hide those writes from the later
        // operations' conflict check. They then keep their base and a write of the same value by this
        // phone shows as a conflict for the person to resolve, never as a silent overwrite.
        const applied = await this.client.getRevision(next.op.projectId, result.revisionId).catch(() => null);
        if (applied?.parentId === next.op.baseRevisionId) {
          for (const later of (await this.store.outbox(next.op.projectId)).filter((x) => x.status === "PENDING")) {
            if (later.op.baseRevisionId === next.op.baseRevisionId) await this.store.setBase(later.op.id, result.revisionId);
          }
        }
        await this.refresh(next.op.projectId).catch(() => undefined); // the head is fetched again next time otherwise
        report.applied++;
      } else if (result.status === "CONFLICT") {
        await this.store.mark(next.op.id, "CONFLICT", { error: result.error, serverRevisionId: result.serverRevisionId });
        blocked.add(next.op.projectId);
        report.conflicts++;
      } else {
        await this.store.mark(next.op.id, "REJECTED", { error: result.error });
        blocked.add(next.op.projectId);
        report.rejected++;
      }
    }
  }
}
