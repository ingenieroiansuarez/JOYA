import { NextResponse, type NextRequest } from "next/server";
import { webConfig } from "../../../lib/server/config";
import { discovery } from "../../../lib/server/oidc";
import { endSession } from "../../../lib/server/session";

export const dynamic = "force-dynamic";

/** POST only, same origin only (a cross-site form must not be able to sign staff out). Ends the IdP session too. */
export async function POST(req: NextRequest) {
  const cfg = webConfig();
  if (req.headers.get("origin") !== cfg.origin) return new NextResponse(null, { status: 403 });
  await endSession(cfg);
  try {
    const d = await discovery(cfg);
    if (d.end_session_endpoint) {
      const u = new URL(d.end_session_endpoint);
      u.search = new URLSearchParams({ client_id: cfg.clientId, post_logout_redirect_uri: `${cfg.origin}/` }).toString();
      return NextResponse.redirect(u.toString(), 303);
    }
  } catch {
    // The local session is already gone; the IdP session ends at its own idle timeout.
  }
  return NextResponse.redirect(new URL("/", cfg.origin), 303);
}
