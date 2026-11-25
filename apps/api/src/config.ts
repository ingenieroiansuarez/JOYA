// Startup configuration. Fails closed: a missing or malformed value stops the process
// before it listens. Never logs values, only variable names.
export const ENVIRONMENTS = ["local", "ci", "demo", "production"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export interface Config {
  env: Environment;
  port: number;
  databaseUrl: string;
  valkeyUrl: string;
  oidc: { issuer: string; audience: string };
  /** Hito 300 design module (design/config.ts loadDesignConfig); absent → design routes answer 503. */
  design?: import("./design/config").DesignConfig;
  /** Hito 400 AURA gateway (ai/config.ts loadAiConfig + adapter); absent → ai routes answer 503. */
  ai?: import("./ai/ai.controller").AiRuntime;
  /** Hito 500 commercial slice (commerce/config.ts loadCommerceConfig); absent → pricing and payment routes answer 503. */
  commerce?: import("./commerce/config").CommerceConfig;
}

export class ConfigError extends Error {}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const missing = ["AUREA_ENV", "DATABASE_URL", "VALKEY_URL", "OIDC_ISSUER", "OIDC_AUDIENCE"].filter((k) => !source[k]);
  if (missing.length) throw new ConfigError(`missing configuration: ${missing.join(", ")}`);
  const env = source.AUREA_ENV as Environment;
  if (!ENVIRONMENTS.includes(env)) throw new ConfigError(`AUREA_ENV must be one of ${ENVIRONMENTS.join(", ")}`);
  const port = Number(source.API_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError("API_PORT must be an integer 0-65535");
  for (const [name, scheme] of [["DATABASE_URL", ["postgres:", "postgresql:"]], ["VALKEY_URL", ["redis:", "rediss:"]]] as const) {
    let url: URL;
    try {
      url = new URL(source[name]!);
    } catch {
      throw new ConfigError(`${name} is not a URL`);
    }
    if (!(scheme as readonly string[]).includes(url.protocol)) throw new ConfigError(`${name} must use ${scheme.join(" or ")}`);
    if ((env === "production" || env === "demo") && !url.password) throw new ConfigError(`${name} needs credentials in ${env}`);
  }
  if (env === "production" && new URL(source.VALKEY_URL!).protocol !== "rediss:") {
    throw new ConfigError("VALKEY_URL must use TLS (rediss:) in production");
  }
  let issuer: URL;
  try {
    issuer = new URL(source.OIDC_ISSUER!);
  } catch {
    throw new ConfigError("OIDC_ISSUER is not a URL");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(issuer.hostname);
  // Demo (hito 600) runs the whole stack on the presenter's laptop; the phone reaches it over USB
  // (adb reverse), so loopback http never crosses a network. Production always needs https.
  if (issuer.protocol !== "https:" && !(issuer.protocol === "http:" && loopback && env !== "production")) {
    throw new ConfigError("OIDC_ISSUER must use https (plain http only on loopback outside production)");
  }
  if (issuer.search || issuer.hash || issuer.username) throw new ConfigError("OIDC_ISSUER must be a bare issuer URL");
  return {
    env,
    port,
    databaseUrl: source.DATABASE_URL!,
    valkeyUrl: source.VALKEY_URL!,
    // Verbatim: the issuer is an identifier compared exactly, and some IdPs end it with "/".
    oidc: { issuer: source.OIDC_ISSUER!, audience: source.OIDC_AUDIENCE! },
  };
}
