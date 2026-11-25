import { redirect } from "next/navigation";
import { webConfig, WebConfigError, type WebConfig } from "./config";
import { refresh } from "./oidc";
import { currentSession, dropSession, updateSession, type Session } from "./session";

export interface ApiError { code: string; message: string; details?: { code: string; pointer?: string; message: string }[] }
export type ApiResult<T> = { ok: true; status: number; body: T } | { ok: false; status: number; error: ApiError };

export interface Me { subject: string; roles: string[]; permissions: string[] }

export type Ctx = { cfg: WebConfig; session: Session };

/** The signed-in staff context, or a redirect to login. A missing configuration is reported, not guessed. */
export async function requireSession(next: string): Promise<Ctx | { notConfigured: string }> {
  let cfg: WebConfig;
  try {
    cfg = webConfig();
  } catch (e) {
    if (e instanceof WebConfigError) return { notConfigured: e.message };
    throw e;
  }
  const session = await currentSession(cfg);
  if (!session) redirect(`/auth/login?next=${encodeURIComponent(next)}`);
  return { cfg, session };
}

async function freshToken(ctx: Ctx): Promise<string | null> {
  const s = ctx.session;
  if (s.expiresAt - Date.now() > 30_000) return s.accessToken;
  if (!s.refreshToken) return null;
  try {
    const t = await refresh(ctx.cfg, s.refreshToken);
    updateSession(s.id, t);
    Object.assign(s, t);
    return t.accessToken;
  } catch {
    return null;
  }
}

/** Calls the AUREA API as the signed-in person. 401 (or a failed refresh) ends the session. */
export async function api<T>(ctx: Ctx, method: "GET" | "POST", path: string, opts: { body?: unknown; idempotencyKey?: string; locale?: string } = {}): Promise<ApiResult<T>> {
  const token = await freshToken(ctx);
  if (!token) {
    dropSession(ctx.session.id);
    redirect("/auth/login?next=/panel");
  }
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, "accept-language": opts.locale ?? "es" };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
  let r: Response;
  try {
    r = await fetch(`${ctx.cfg.apiUrl}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), cache: "no-store", signal: AbortSignal.timeout(10_000) });
  } catch {
    return { ok: false, status: 503, error: { code: "SERVICE_UNAVAILABLE", message: "API no disponible" } };
  }
  if (r.status === 401) {
    dropSession(ctx.session.id);
    redirect("/auth/login?next=/panel");
  }
  const body = await r.json().catch(() => null);
  return r.ok ? { ok: true, status: r.status, body: body as T } : { ok: false, status: r.status, error: (body as ApiError) ?? { code: "INTERNAL_ERROR", message: "" } };
}
