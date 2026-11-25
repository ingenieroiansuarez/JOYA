
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
  /** Cookie name prefix: the demo panel's own, so a demo and a local panel on 127.0.0.1 (cookies ignore the port) never overwrite each other's session. */
  cookiePrefix: string;
}

export class WebConfigError extends Error {}

export function webConfig(env: NodeJS.ProcessEnv = process.env): WebConfig {
  const missing = ["OIDC_ISSUER", "KC_WEB_CLIENT_SECRET", "WEB_SESSION_SECRET"].filter((k) => !env[k]);
  if (missing.length) throw new WebConfigError(`missing configuration: ${missing.join(", ")}`);
  if (env.WEB_SESSION_SECRET!.length < 32) throw new WebConfigError("WEB_SESSION_SECRET must be at least 32 characters");
  const origin = (env.WEB_ORIGIN ?? "http://127.0.0.1:3100").replace(/\/$/, "");
  const apiUrl = (env.AUREA_API_URL ?? `http://127.0.0.1:${env.API_PORT ?? 3000}/v1`).replace(/\/$/, "");
  // Demo (hito 600) runs on the presenter's laptop: http only on loopback. Production: https only.
  const loopback = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
  if (env.AUREA_ENV === "production" && !origin.startsWith("https://")) throw new WebConfigError("WEB_ORIGIN must use https in production");
  if (env.AUREA_ENV === "demo" && !origin.startsWith("https://") && !loopback) {
    throw new WebConfigError("WEB_ORIGIN must use https in demo (plain http only on loopback)");
  }
  return {
    issuer: env.OIDC_ISSUER!.replace(/\/$/, ""),
    clientId: env.WEB_OIDC_CLIENT_ID ?? "aurea-web",
    clientSecret: env.KC_WEB_CLIENT_SECRET!,
    origin,
    apiUrl,
    sessionSecret: env.WEB_SESSION_SECRET!,
    secureCookies: origin.startsWith("https://"),
    cookiePrefix: env.AUREA_ENV === "demo" ? "aurea_demo" : "aurea",
  };
}
