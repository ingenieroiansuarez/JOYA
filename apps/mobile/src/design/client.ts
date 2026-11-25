// Design endpoints on top of Api.send. Every creating call carries an Idempotency-Key the caller
// chooses, so a retry after a dropped answer returns the first result instead of creating twice.
import type { Api } from "../api";
import type { ArtifactDownload, DesignOperation, Job, Project, ProjectPage, Revision, SyncOperation, SyncResult } from "./types";

export type WithToken = <T>(fn: (token: string) => Promise<T>) => Promise<T>;

export class DesignClient {
  constructor(private readonly api: Api, private readonly withToken: WithToken) {}

  private call<T>(method: string, path: string, opts: { body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
    return this.withToken((token) => this.api.send<T>(method, path, { ...opts, token }) as Promise<T>);
  }

  listProjects(cursor?: string | null): Promise<ProjectPage> {
    return this.call("GET", `/projects${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
  }
  getProject(id: string): Promise<Project> {
    return this.call("GET", `/projects/${encodeURIComponent(id)}`);
  }
  getRevision(projectId: string, revisionId: string): Promise<Revision> {
    return this.call("GET", `/projects/${encodeURIComponent(projectId)}/revisions/${encodeURIComponent(revisionId)}`);
  }
  createProject(body: { title: string; templateId: string; materialId: string }, idempotencyKey: string): Promise<Project> {
    return this.call("POST", "/projects", { body, idempotencyKey });
  }
  /** Validated by the API and queued as a PREVIEW job; never moves the head. */
  proposeOperation(projectId: string, baseRevisionId: string, operation: DesignOperation, idempotencyKey: string): Promise<Job> {
    return this.call("POST", `/projects/${encodeURIComponent(projectId)}/operations`, { body: { baseRevisionId, operation }, idempotencyKey });
  }
  /** The person's explicit acceptance of a preview: appends the next revision. */
  acceptPreview(projectId: string, baseRevisionId: string, previewJobId: string, idempotencyKey: string): Promise<Revision> {
    return this.call("POST", `/projects/${encodeURIComponent(projectId)}/revisions`, {
      body: { baseRevisionId, previewJobId, accepted: true }, idempotencyKey,
    });
  }
  /** Geometry of an existing revision (reused server-side for the same digest). */
  buildRevision(revisionId: string, idempotencyKey: string): Promise<Job> {
    return this.call("POST", "/geometry/jobs", { body: { revisionId, quality: "INTERACTIVE" }, idempotencyKey });
  }
  getJob(id: string): Promise<Job> {
    return this.call("GET", `/jobs/${encodeURIComponent(id)}`);
  }
  artifactUrl(jobId: string, artifactId: string): Promise<ArtifactDownload> {
    return this.call("GET", `/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(artifactId)}`);
  }
  push(deviceId: string, operations: SyncOperation[], idempotencyKey: string): Promise<SyncResult> {
    return this.call("POST", "/sync/push", { body: { deviceId, operations }, idempotencyKey });
  }
}
