import type { WebConfig } from "./config";
import { pkceChallenge, type Tokens } from "./session";

// Authorization Code + PKCE (S256) against the configured issuer, as a confidential client.
interface Discovery { authorization_endpoint: string; token_endpoint: string; end_session_endpoint?: string; issuer: string }
let cached: { issuer: string; doc: Discovery; at: number } | null = null;

export class OidcError extends Error {}

export async function discovery(cfg: WebConfig): Promise<Discovery> {
  if (cached && cached.issuer === cfg.issuer && Date.now() - cached.at < 10 * 60_000) return cached.doc;
  const r = await fetch(`${cfg.issuer}/.well-known/openid-configuration`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new OidcError(`discovery ${r.status}`);
  const doc = (await r.json()) as Discovery;
  if (doc.issuer.replace(/\/$/, "") !== cfg.issuer) throw new OidcError("issuer mismatch");
  cached = { issuer: cfg.issuer, doc, at: Date.now() };
  return doc;
}

export async function authorizeUrl(cfg: WebConfig, args: { state: string; verifier: string; nonce: string }): Promise<string> {
  const d = await discovery(cfg);
  const u = new URL(d.authorization_endpoint);
  u.search = new URLSearchParams({
    response_type: "code", client_id: cfg.clientId, redirect_uri: `${cfg.origin}/auth/callback`, scope: "openid",
    state: args.state, nonce: args.nonce, code_challenge: pkceChallenge(args.verifier), code_challenge_method: "S256",
  }).toString();
  return u.toString();
}

async function tokenCall(cfg: WebConfig, body: Record<string, string>): Promise<Tokens & { idToken?: string }> {
  const d = await discovery(cfg);
  const r = await fetch(d.token_endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`).toString("base64")}`,
    },
    body: new URLSearchParams(body).toString(),
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new OidcError(`token ${r.status}`);
  const t = (await r.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; id_token?: string };
  if (!t.access_token || typeof t.expires_in !== "number") throw new OidcError("token response incomplete");
  return { accessToken: t.access_token, refreshToken: t.refresh_token ?? null, expiresAt: Date.now() + t.expires_in * 1000, idToken: t.id_token };
}

export const exchangeCode = (cfg: WebConfig, code: string, verifier: string) =>
  tokenCall(cfg, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: `${cfg.origin}/auth/callback` });

export const refresh = (cfg: WebConfig, refreshToken: string) => tokenCall(cfg, { grant_type: "refresh_token", refresh_token: refreshToken });

/** Nonce check on the ID token's payload (the API verifies the access token's signature on every call). */
export function nonceMatches(idToken: string | undefined, nonce: string): boolean {
  if (!idToken) return false;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8")) as { nonce?: string };
    return payload.nonce === nonce;
  } catch {
    return false;
  }
}
