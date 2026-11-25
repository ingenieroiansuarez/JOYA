import { ConfigError, type Environment } from "../config";

export interface AiConfig {
  /** Only "simulated" exists in hito 400; a real provider needs ian's authorization and credentials. */
  provider: "simulated";
  /** Quota units per person and UTC day (one proposal = 1 unit with the simulator). */
  dailyUnits: number;
  /** Proposals per request (12_AI_ORCHESTRATION: default 3). */
  maxOptions: number;
  timeoutMs: number;
  proposalTtlS: number;
}

function int(source: NodeJS.ProcessEnv, name: string, def: number, min: number, max: number): number {
  const raw = source[name];
  const v = raw === undefined ? def : Number(raw);
  if (!Number.isInteger(v) || v < min || v > max) throw new ConfigError(`${name} must be an integer ${min}-${max}`);
  return v;
}

/**
 * Fails closed: production refuses the simulator (CLAUDE.md, simulators explicit) and any provider
 * that is not implemented; there are no provider keys in this milestone.
 */
export function loadAiConfig(source: NodeJS.ProcessEnv, env: Environment): AiConfig {
  const provider = source.AI_PROVIDER ?? (env === "production" ? undefined : "simulated");
  if (!provider) throw new ConfigError("AI_PROVIDER is required in production");
  if (provider !== "simulated") throw new ConfigError(`AI_PROVIDER ${provider} is not available (only simulated)`);
  if (env === "production") throw new ConfigError("the simulated AI provider is not allowed in production");
  return {
    provider,
    dailyUnits: int(source, "AI_DAILY_UNITS", 30, 1, 10_000),
    maxOptions: int(source, "AI_MAX_OPTIONS", 3, 1, 5),
    timeoutMs: int(source, "AI_TIMEOUT_MS", 15_000, 100, 120_000),
    proposalTtlS: int(source, "AI_PROPOSAL_TTL_S", 1800, 60, 86_400),
  };
}
