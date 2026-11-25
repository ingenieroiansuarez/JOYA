import type { Family, Material } from "./catalog";
export type { Family, FamilyParameter, Localized, Material } from "./catalog";
export declare const FAMILIES: Family[];
export declare const MATERIALS: Material[];
export declare const SCHEMA_VERSION: "1.0.0";
export declare const MAIN_BRANCH: "main";
export declare const COMPONENT_ID: RegExp;
export declare const SUPPORTED_OPERATIONS: readonly string[];

export interface Component {
  id: string;
  family: string;
  familyVersion: string;
  materialId: string;
  parameters: Record<string, number | string | boolean>;
  transform: { translation: [number, number, number]; rotationQuaternion: [number, number, number, number] };
  dependsOn: string[];
}
export interface DesignDocument {
  schemaVersion: "1.0.0";
  projectId: string;
  revision: number;
  units: "mm";
  components: Component[];
  operations: unknown[];
  constraints: { type: string; target: string; parameters: Record<string, number | string | boolean> }[];
}
export type DesignOperation =
  | { type: "modify_parameter"; componentId: string; name: string; value: number }
  | { type: "change_material"; componentId: string; materialId: string }
  | { type: string; [k: string]: unknown };
export interface Issue { code: string; path: string; message: string }
export type Result = { ok: true; document: DesignDocument } | { ok: false; issues: Issue[] };

export declare function family(id: string): Family | undefined;
export declare function material(id: string): Material | undefined;
export declare function canonicalJson(value: unknown): string;
export declare function newDocument(args: { projectId: string; familyId: string; materialId: string }): Result;
export declare function validateDocument(doc: unknown): Issue[];
export declare function touchedKeys(op: DesignOperation): string[];
export declare function applyOperation(doc: DesignDocument, op: DesignOperation): Result;
export declare function applyAll(doc: DesignDocument, ops: DesignOperation[]): Result;
export declare function canRebase(op: DesignOperation, appliedSince: DesignOperation[]): boolean;
export declare function diffParameters(
  before: DesignDocument,
  after: DesignDocument,
): { componentId: string; name: string; from: unknown; to: unknown }[];
