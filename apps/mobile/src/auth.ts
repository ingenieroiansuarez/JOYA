import {
  AuthRequest,
  CodeChallengeMethod,
  exchangeCodeAsync,
  refreshAsync,
  fetchDiscoveryAsync,
  ResponseType,
  revokeAsync,
  TokenError,
  TokenTypeHint,
  type DiscoveryDocument,
} from "expo-auth-session";
import * as SecureStore from "expo-secure-store";
import { CLIENT_ID, REDIRECT_URI, type AppConfig } from "./config";

const REFRESH_KEY = "aurea.refreshToken";
// The subject (an opaque id, not PII) of the account whose refresh token is stored. Lets the app open
// that account's local designs after a restart without connection; never used to call the API.
const SUBJECT_KEY = "aurea.subject";

export async function rememberSubject(subject: string): Promise<void> {
  await SecureStore.setItemAsync(SUBJECT_KEY, subject);
}

/** The remembered subject, only while its refresh token is still stored (not signed out or revoked). */
export async function rememberedSubject(): Promise<string | null> {
  const [token, subject] = await Promise.all([SecureStore.getItemAsync(REFRESH_KEY), SecureStore.getItemAsync(SUBJECT_KEY)]);
  return token && subject ? subject : null;
}

/** Authorization Code with PKCE S256 (RFC 7636). Public client: no secret exists to leak. */
export function buildAuthRequest(): AuthRequest {
  return new AuthRequest({
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    scopes: ["openid"],
    responseType: ResponseType.Code,
    usePKCE: true,
    codeChallengeMethod: CodeChallengeMethod.S256,
  });
}

export async function discover(config: AppConfig): Promise<DiscoveryDocument> {
  const doc = await fetchDiscoveryAsync(config.issuer);
  if (!doc.authorizationEndpoint || !doc.tokenEndpoint) throw new Error("discovery without endpoints");
  return doc;
}

export interface Session {
  accessToken: string;
  /** Epoch ms after which the access token must not be used (5 s early, for clock skew and latency). */
  expiresAt: number;
}

function sessionFrom(tokens: { accessToken: string; expiresIn?: number; issuedAt?: number }, now = Date.now()): Session {
  const lifetimeS = tokens.expiresIn ?? 60;
  return { accessToken: tokens.accessToken, expiresAt: now + Math.max(0, lifetimeS - 5) * 1000 };
}

export const isFresh = (session: Session | null, now = Date.now()): session is Session => !!session && now < session.expiresAt;

/**
 * Opens the system browser, then exchanges the code with the verifier. The access token stays in
 * memory; only the refresh token is persisted, in the Android Keystore via SecureStore.
 */
export async function signIn(discovery: DiscoveryDocument, request = buildAuthRequest()): Promise<Session | null> {
  const result = await request.promptAsync(discovery);
  if (result.type !== "success") return null;
  const tokens = await exchangeCodeAsync(
    { clientId: CLIENT_ID, redirectUri: REDIRECT_URI, code: result.params.code, extraParams: { code_verifier: request.codeVerifier ?? "" } },
    discovery,
  );
  if (tokens.refreshToken) await SecureStore.setItemAsync(REFRESH_KEY, tokens.refreshToken);
  return sessionFrom(tokens);
}

/**
 * A new access token from the stored refresh token (rotated by the realm, so the new one replaces it).
 * Returns null when there is none or the IdP refuses it (expired, revoked): the app is a guest again.
 * Network failures throw, so the caller can tell "offline" from "signed out".
 */
export async function refresh(discovery: DiscoveryDocument): Promise<Session | null> {
  const stored = await SecureStore.getItemAsync(REFRESH_KEY);
  if (!stored) return null;
  let tokens;
  try {
    tokens = await refreshAsync({ clientId: CLIENT_ID, refreshToken: stored }, discovery);
  } catch (err) {
    // TokenError: the IdP answered with an OAuth error (invalid_grant…). Anything else is the network.
    if (err instanceof TokenError) {
      await SecureStore.deleteItemAsync(REFRESH_KEY);
      await SecureStore.deleteItemAsync(SUBJECT_KEY);
      return null;
    }
    throw err;
  }
  if (tokens.refreshToken) await SecureStore.setItemAsync(REFRESH_KEY, tokens.refreshToken);
  return sessionFrom(tokens);
}

export async function signOut(discovery: DiscoveryDocument): Promise<void> {
  const refresh = await SecureStore.getItemAsync(REFRESH_KEY);
  await SecureStore.deleteItemAsync(REFRESH_KEY);
  await SecureStore.deleteItemAsync(SUBJECT_KEY);
  if (refresh && discovery.revocationEndpoint) {
    await revokeAsync({ clientId: CLIENT_ID, token: refresh, tokenTypeHint: TokenTypeHint.RefreshToken }, discovery).catch(() => undefined);
  }
}

export interface Me {
  subject: string;
  roles: string[];
  permissions: string[];
}

export async function fetchMe(config: AppConfig, session: Session): Promise<Me> {
  const r = await fetch(`${config.apiUrl}/v1/me`, { headers: { authorization: `Bearer ${session.accessToken}` } });
  if (!r.ok) throw new Error(`api ${r.status}`);
  return (await r.json()) as Me;
}
