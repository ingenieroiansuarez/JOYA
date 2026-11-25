import type { JWTVerifyGetKey } from "jose";
import type { Config } from "../config";

/** Asymmetric only: `none` and HMAC (a shared secret the API would have to hold) are refused. */
export const ALGORITHMS = ["RS256", "PS256", "ES256", "EdDSA"];
export const CLOCK_TOLERANCE_S = 30;
const FETCH_TIMEOUT_MS = 3000;

export interface TokenVerifier {
  /** Resolves the verified claims. Rejects with VerifierUnavailable (503) or anything else (401). */
  verify(token: string): Promise<Record<string, unknown>>;
}

/** The IdP or its keys could not be reached: not the caller's fault, and never a reason to let them in. */
export class VerifierUnavailable extends Error {}

/** Reads jwks_uri from the issuer's discovery document, so the API is not tied to one IdP. */
async function discoverJwksUri(issuer: string): Promise<URL> {
  const res = await fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new VerifierUnavailable(`discovery answered ${res.status}`);
  const doc = (await res.json()) as { issuer?: string; jwks_uri?: string };
  if (doc.issuer !== issuer || !doc.jwks_uri) throw new VerifierUnavailable("discovery issuer mismatch or no jwks_uri");
  return new URL(doc.jwks_uri);
}

export async function createVerifier(config: Config, keys?: JWTVerifyGetKey): Promise<TokenVerifier> {
  const jose = await import("jose");
  let remote: Promise<JWTVerifyGetKey> | undefined;
  const resolveKeys = (): Promise<JWTVerifyGetKey> => {
    if (keys) return Promise.resolve(keys);
    remote ??= discoverJwksUri(config.oidc.issuer)
      .then((uri) => jose.createRemoteJWKSet(uri, { timeoutDuration: FETCH_TIMEOUT_MS, cooldownDuration: 30_000 }))
      .catch((err) => {
        remote = undefined; // retry discovery on the next request
        throw err;
      });
    return remote;
  };
  const unavailable = (err: unknown) =>
    err instanceof VerifierUnavailable ||
    err instanceof jose.errors.JWKSTimeout ||
    err instanceof jose.errors.JWKSInvalid ||
    !(err instanceof jose.errors.JOSEError) ||
    (err as { code?: string }).code === "ERR_JOSE_GENERIC"; // e.g. JWKS endpoint not 200
  return {
    async verify(token) {
      try {
        const { payload } = await jose.jwtVerify(token, await resolveKeys(), {
          issuer: config.oidc.issuer,
          audience: config.oidc.audience,
          algorithms: ALGORITHMS,
          clockTolerance: CLOCK_TOLERANCE_S,
          requiredClaims: ["sub", "exp", "iat"],
        });
        return payload as Record<string, unknown>;
      } catch (err) {
        if (unavailable(err)) throw new VerifierUnavailable(err instanceof Error ? err.constructor.name : "unknown");
        throw err;
      }
    },
  };
}
