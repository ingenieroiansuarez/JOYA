// Startup configuration. Fails closed: a missing or malformed value stops the process
// before it listens. Never logs values, only variable names.
export const ENVIRONMENTS = ["local", "ci", "demo", "production"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export interface Config {
  env: Environment;
  port: number;
  databaseUrl: string;
  valkeyUrl: string;
}

export class ConfigError extends Error {}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const missing = ["AUREA_ENV", "DATABASE_URL", "VALKEY_URL"].filter((k) => !source[k]);
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
  return { env, port, databaseUrl: source.DATABASE_URL!, valkeyUrl: source.VALKEY_URL! };
}
