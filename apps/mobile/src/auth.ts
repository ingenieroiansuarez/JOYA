import {
  AuthRequest,
  CodeChallengeMethod,
  exchangeCodeAsync,
  fetchDiscoveryAsync,
  ResponseType,
  revokeAsync,
  TokenTypeHint,
  type DiscoveryDocument,
} from "expo-auth-session";
import * as SecureStore from "expo-secure-store";
import { CLIENT_ID, REDIRECT_URI, type AppConfig } from "./config";

const REFRESH_KEY = "aurea.refreshToken";

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
}

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
  return { accessToken: tokens.accessToken };
}

export async function signOut(discovery: DiscoveryDocument): Promise<void> {
  const refresh = await SecureStore.getItemAsync(REFRESH_KEY);
  await SecureStore.deleteItemAsync(REFRESH_KEY);
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
