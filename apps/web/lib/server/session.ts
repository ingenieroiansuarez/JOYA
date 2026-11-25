import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import type { WebConfig } from "./config";

// Server-side sessions: the browser only holds a random, HMAC-signed id in an HttpOnly cookie;
// tokens never reach it. The store is in process memory (local/demo: one Next process); a restart
// signs everybody out. A shared store (Valkey) comes with a multi-instance deployment.

export interface Tokens { accessToken: string; refreshToken: string | null; expiresAt: number }
export interface Session extends Tokens { id: string; createdAt: number }
export interface PendingLogin { verifier: string; nonce: string; next: string; createdAt: number }

const SESSION_COOKIE = "aurea_sid";
const LOGIN_COOKIE = "aurea_login";
const SESSION_TTL_MS = 30 * 60_000; // matches the realm's SSO idle timeout
const LOGIN_TTL_MS = 10 * 60_000;

interface Store { sessions: Map<string, Session>; logins: Map<string, PendingLogin> }
const g = globalThis as typeof globalThis & { __aureaStore?: Store };
const store: Store = (g.__aureaStore ??= { sessions: new Map(), logins: new Map() });

export const random = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

function seal(secret: string, value: string): string {
  return `${value}.${createHmac("sha256", secret).update(value).digest("base64url")}`;
}
function unseal(secret: string, sealed: string | undefined): string | null {
  if (!sealed) return null;
  const i = sealed.lastIndexOf(".");
  if (i <= 0) return null;
  const value = sealed.slice(0, i);
  const want = Buffer.from(createHmac("sha256", secret).update(value).digest("base64url"));
  const got = Buffer.from(sealed.slice(i + 1));
  return want.length === got.length && timingSafeEqual(want, got) ? value : null;
}

function sweep(now = Date.now()) {
  for (const [k, s] of store.sessions) if (now - s.createdAt > SESSION_TTL_MS * 16 || (!s.refreshToken && s.expiresAt < now)) store.sessions.delete(k);
  for (const [k, l] of store.logins) if (now - l.createdAt > LOGIN_TTL_MS) store.logins.delete(k);
}

const cookieOpts = (cfg: WebConfig, maxAge: number) => ({ httpOnly: true, sameSite: "lax" as const, secure: cfg.secureCookies, path: "/", maxAge });

/** Starts a login: state → verifier/nonce on the server, the state bound to this browser by cookie. */
export async function beginLogin(cfg: WebConfig, next: string): Promise<{ state: string; verifier: string; nonce: string }> {
  sweep();
  const state = random();
  const login = { verifier: random(48), nonce: random(), next: safeNext(next), createdAt: Date.now() };
  store.logins.set(state, login);
  (await cookies()).set(LOGIN_COOKIE, seal(cfg.sessionSecret, state), cookieOpts(cfg, LOGIN_TTL_MS / 1000));
  return { state, verifier: login.verifier, nonce: login.nonce };
}

/** Consumes a login once: the state must match this browser's cookie and not be expired. */
export async function takeLogin(cfg: WebConfig, state: string | null): Promise<PendingLogin | null> {
  const jar = await cookies();
  const bound = unseal(cfg.sessionSecret, jar.get(LOGIN_COOKIE)?.value);
  jar.delete(LOGIN_COOKIE);
  if (!state || !bound || bound !== state) return null;
  const login = store.logins.get(state);
  store.logins.delete(state);
  if (!login || Date.now() - login.createdAt > LOGIN_TTL_MS) return null;
  return login;
}

export async function startSession(cfg: WebConfig, tokens: Tokens): Promise<void> {
  sweep();
  const id = random();
  store.sessions.set(id, { id, createdAt: Date.now(), ...tokens });
  (await cookies()).set(SESSION_COOKIE, seal(cfg.sessionSecret, id), cookieOpts(cfg, SESSION_TTL_MS * 16 / 1000));
}

export async function currentSession(cfg: WebConfig): Promise<Session | null> {
  const id = unseal(cfg.sessionSecret, (await cookies()).get(SESSION_COOKIE)?.value);
  return id ? store.sessions.get(id) ?? null : null;
}

export function updateSession(id: string, tokens: Tokens): void {
  const s = store.sessions.get(id);
  if (s) store.sessions.set(id, { ...s, ...tokens });
}

export function dropSession(id: string): void {
  store.sessions.delete(id);
}

export async function endSession(cfg: WebConfig): Promise<Session | null> {
  const jar = await cookies();
  const id = unseal(cfg.sessionSecret, jar.get(SESSION_COOKIE)?.value);
  jar.delete(SESSION_COOKIE);
  const s = id ? store.sessions.get(id) ?? null : null;
  if (id) store.sessions.delete(id);
  return s;
}

/** Only same-site panel paths: an open redirect would let a link send staff anywhere after login. */
export function safeNext(next: string | null | undefined): string {
  return next && /^\/panel(\/[a-z-]*)?$/.test(next) ? next : "/panel";
}
