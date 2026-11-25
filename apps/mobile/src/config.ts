// Build-time configuration (EXPO_PUBLIC_* is inlined by Metro). Fails closed: a missing or unsafe
// value produces a ConfigError the UI shows; there is no default issuer or API.
export const CLIENT_ID = "aurea-mobile";
/** Must equal the realm's redirect (infra/keycloak, scripts/identity-gen.mjs MOBILE_REDIRECT). */
export const REDIRECT_URI = "com.aurea.customer.dev:/oauthredirect";
export const ENVIRONMENTS = ["local", "ci", "demo", "production"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export interface AppConfig {
  env: Environment;
  issuer: string;
  apiUrl: string;
}

export class ConfigError extends Error {}

function url(name: string, value: string | undefined, env: Environment): string {
  if (!value) throw new ConfigError(`missing ${name}`);
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new ConfigError(`${name} is not a URL`);
  }
  // Plain http only for local/ci builds (a dev phone reaches the laptop over the LAN).
  if (u.protocol !== "https:" && !(u.protocol === "http:" && (env === "local" || env === "ci"))) {
    throw new ConfigError(`${name} must use https in ${env}`);
  }
  return value;
}

export function loadConfig(source: Record<string, string | undefined>): AppConfig {
  const env = source.EXPO_PUBLIC_AUREA_ENV as Environment;
  if (!ENVIRONMENTS.includes(env)) throw new ConfigError("EXPO_PUBLIC_AUREA_ENV must be local, ci, demo or production");
  return {
    env,
    issuer: url("EXPO_PUBLIC_OIDC_ISSUER", source.EXPO_PUBLIC_OIDC_ISSUER, env),
    apiUrl: url("EXPO_PUBLIC_API_URL", source.EXPO_PUBLIC_API_URL, env).replace(/\/$/, ""),
  };
}

/** Metro only inlines literal process.env.EXPO_PUBLIC_* reads, so list them one by one. */
export function configFromBuild(): AppConfig {
  return loadConfig({
    EXPO_PUBLIC_AUREA_ENV: process.env.EXPO_PUBLIC_AUREA_ENV,
    EXPO_PUBLIC_OIDC_ISSUER: process.env.EXPO_PUBLIC_OIDC_ISSUER,
    EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL,
  });
}
