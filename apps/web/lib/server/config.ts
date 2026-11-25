
// Web BFF configuration (SECURITY.md: web = BFF with a Secure HttpOnly SameSite session cookie).
// Read on the server only; never sent to the browser. Fails closed: a missing value disables the
// panel ("not configured") instead of guessing.
export interface WebConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  origin: string;
  apiUrl: string;
  sessionSecret: string;
  secureCookies: boolean;
}

export class WebConfigError extends Error {}

export function webConfig(env: NodeJS.ProcessEnv = process.env): WebConfig {
  const missing = ["OIDC_ISSUER", "KC_WEB_CLIENT_SECRET", "WEB_SESSION_SECRET"].filter((k) => !env[k]);
  if (missing.length) throw new WebConfigError(`missing configuration: ${missing.join(", ")}`);
  if (env.WEB_SESSION_SECRET!.length < 32) throw new WebConfigError("WEB_SESSION_SECRET must be at least 32 characters");
  const origin = (env.WEB_ORIGIN ?? "http://127.0.0.1:3100").replace(/\/$/, "");
  const apiUrl = (env.AUREA_API_URL ?? `http://127.0.0.1:${env.API_PORT ?? 3000}/v1`).replace(/\/$/, "");
  const prodLike = env.AUREA_ENV === "production" || env.AUREA_ENV === "demo";
  if (prodLike && !origin.startsWith("https://")) throw new WebConfigError(`WEB_ORIGIN must use https in ${env.AUREA_ENV}`);
  return {
    issuer: env.OIDC_ISSUER!.replace(/\/$/, ""),
    clientId: env.WEB_OIDC_CLIENT_ID ?? "aurea-web",
    clientSecret: env.KC_WEB_CLIENT_SECRET!,
    origin,
    apiUrl,
    sessionSecret: env.WEB_SESSION_SECRET!,
    secureCookies: origin.startsWith("https://"),
  };
}
