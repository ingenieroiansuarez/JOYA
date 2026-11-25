import { NextResponse, type NextRequest } from "next/server";
import { webConfig, WebConfigError } from "../../../lib/server/config";
import { authorizeUrl } from "../../../lib/server/oidc";
import { beginLogin } from "../../../lib/server/session";

export const dynamic = "force-dynamic";

/** Starts Authorization Code + PKCE: state/verifier/nonce stay on the server, the browser goes to the IdP. */
export async function GET(req: NextRequest) {
  let cfg;
  try {
    cfg = webConfig();
  } catch (e) {
    if (e instanceof WebConfigError) return NextResponse.redirect(new URL("/auth/error?reason=config", req.url), 303);
    throw e;
  }
  try {
    const login = await beginLogin(cfg, req.nextUrl.searchParams.get("next") ?? "/panel");
    return NextResponse.redirect(await authorizeUrl(cfg, login), 303);
  } catch {
    return NextResponse.redirect(new URL("/auth/error?reason=idp", cfg.origin), 303);
  }
}
