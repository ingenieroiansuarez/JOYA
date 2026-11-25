// Shapes of the design endpoints (06_API_CONTRACTS/openapi.yaml 1.9.0), only what the app reads.
import type { DesignDocument, DesignOperation } from "@aurea/design";

export type { DesignDocument, DesignOperation };

export interface Project {
  id: string; title: string; familyId: string; headRevisionId: string; headRevisionNumber: number; createdAt: string; updatedAt: string;
}
export interface ProjectPage { items: Project[]; nextCursor: string | null }
export interface ParameterChange { componentId: string; name: string; from: number | string | boolean | null; to: number | string | boolean }
export interface Revision {
  id: string; projectId: string; number: number; digest: string; document: DesignDocument; parentId: string | null; createdAt: string;
}
export interface ComponentMetrics {
  id: string; family: string; materialId: string; volumeMm3: string; massGramsEstimate: string;
  densityStatus: "NOMINAL_UNCONFIRMED" | "CONFIGURED"; boundingBoxMm: [number, number, number]; minWallMm: number;
}
export interface JobSummary {
  document: DesignDocument; changes: ParameterChange[]; components: ComponentMetrics[];
  dfmState: "PASS" | "WARN" | "REVIEW" | "FAIL"; humanApprovalRequired: true; engineVersion: string; status: string;
}
export interface JobArtifact { id: string; kind: "STEP" | "STL" | "GLB_PREVIEW" | "DFM_REPORT" | "MANIFEST" | string; units: string; sha256: string; bytes: number; name: string }
export type JobState = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
export interface Job {
  id: string; kind: "PREVIEW" | "GEOMETRY" | string; state: JobState; projectId: string; revisionId: string; simulated: boolean;
  errorCode: string | null; artifacts: JobArtifact[]; summary: JobSummary | null;
}
export interface ArtifactDownload { url: string; expiresAt: string; sha256: string }

export interface SyncOperation {
  id: string; projectId: string; branch: "main"; baseRevisionId: string; sequence: number; createdAt: string; operation: DesignOperation;
}
export type SyncOperationResult =
  | { operationId: string; status: "APPLIED"; revisionId: string }
  | { operationId: string; status: "CONFLICT"; serverRevisionId: string; error: { code: string; message: string } }
  | { operationId: string; status: "REJECTED"; error: { code: string; pointer?: string; message: string } };
export interface SyncResult { results: SyncOperationResult[]; cursor: string }
