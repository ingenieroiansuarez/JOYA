import { NextResponse, type NextRequest } from "next/server";
import { webConfig, WebConfigError } from "../../../lib/server/config";
import { exchangeCode, nonceMatches } from "../../../lib/server/oidc";
import { startSession, takeLogin } from "../../../lib/server/session";

export const dynamic = "force-dynamic";

/** The IdP's redirect: the state must be this browser's, the code is exchanged once with the PKCE verifier. */
export async function GET(req: NextRequest) {
  let cfg;
  try {
    cfg = webConfig();
  } catch (e) {
    if (e instanceof WebConfigError) return NextResponse.redirect(new URL("/auth/error?reason=config", req.url), 303);
    throw e;
  }
  const fail = (reason: string) => NextResponse.redirect(new URL(`/auth/error?reason=${reason}`, cfg.origin), 303);
  const q = req.nextUrl.searchParams;
  const login = await takeLogin(cfg, q.get("state"));
  if (!login) return fail("state");
  if (q.get("error")) return fail("denied");
  const code = q.get("code");
  if (!code) return fail("state");
  try {
    const t = await exchangeCode(cfg, code, login.verifier);
    if (!nonceMatches(t.idToken, login.nonce)) return fail("nonce");
    await startSession(cfg, { accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt });
  } catch {
    return fail("idp");
  }
  return NextResponse.redirect(new URL(login.next, cfg.origin), 303);
}
