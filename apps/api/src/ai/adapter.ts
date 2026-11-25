import type { DesignDocument, DesignOperation } from "@aurea/design";

export type Locale = "es" | "en";

/** Things AURA could not or would not turn into an operation; shown to the person as-is. */
export type NoteCode =
  | "ASSUMPTION"
  | "OUT_OF_RANGE"
  | "NEEDS_JEWELER"
  | "UNSUPPORTED"
  | "IGNORED_INSTRUCTION"
  | "NOT_UNDERSTOOD"
  | "ALREADY_SO";
export interface Note { code: NoteCode; message: string }

/** What an adapter returns. Untrusted: the gateway rebuilds and validates every operation. */
export interface RawOption { title: string; summary: string; operations: unknown[]; assumptions: string[] }
export interface AdapterResult {
  options: RawOption[];
  /** Short phrases of what was understood, in the person's language. */
  understood: string[];
  notes: Note[];
}

export interface GenerateInput {
  prompt: string;
  document: DesignDocument;
  locale: Locale;
  maxOptions: number;
}

/**
 * 12_AI_ORCHESTRATION: every adapter implements generate, health, capabilities and estimateCost.
 * poll/cancel apply to asynchronous providers (concept images, meshes) and come with them.
 */
export interface AiAdapter {
  readonly id: string;
  readonly model: string;
  readonly simulated: boolean;
  capabilities(): readonly string[];
  health(): Promise<boolean>;
  /** Units reserved in the quota ledger before calling generate. */
  estimateCost(prompt: string): number;
  generate(input: GenerateInput, signal: AbortSignal): Promise<AdapterResult>;
}

export type { DesignOperation };
