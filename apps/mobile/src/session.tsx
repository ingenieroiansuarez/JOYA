// App-wide session: configuration, translations, API client, sign-in state and the customer's favorites.
// Guests browse freely; saving a favorite asks them to sign in (REQ-02-01). The access token lives only
// in memory and is refreshed from the Keystore-held refresh token when it expires.
import type { DiscoveryDocument } from "expo-auth-session";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Api, ApiError } from "./api";
import { discover, fetchMe, isFresh, refresh, rememberedSubject, rememberSubject, signIn as browserSignIn, signOut as revoke, type Me, type Session } from "./auth";
import type { AppConfig } from "./config";
import { ensureDiscovery } from "./login";
import { deviceLocale, translator, type Locale } from "./i18n";

export type AuthStatus = "restoring" | "guest" | "signingIn" | "failed" | "signedIn";
export type FavoriteResult = "saved" | "removed" | "needsSignIn" | "failed";

interface SessionValue {
  config: AppConfig;
  locale: Locale;
  t: ReturnType<typeof translator>;
  api: Api;
  status: AuthStatus;
  me: Me | null;
  /**
   * Whose local data (offline designs) this device may open: the signed-in subject, or, after a launch
   * without connection, the subject whose refresh token is still stored. Not a sign-in: the API still
   * needs a token, and the first successful refresh signs the customer in.
   */
  localOwner: string | null;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  /** Runs fn with a valid access token: refreshes when stale and retries once after a 401. */
  withToken<T>(fn: (token: string) => Promise<T>): Promise<T>;
  favorites: ReadonlySet<string>;
  favoritesVersion: number;
  /** Loads the saved set again if the load after sign-in failed, so "Save"/"Remove" labels are right. */
  ensureFavorites(): Promise<void>;
  /** Saves (true) or removes (false) explicitly; PUT and DELETE are idempotent, so a stale label never inverts intent. */
  setFavorite(id: string, saved: boolean): Promise<FavoriteResult>;
}

const Ctx = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSession outside SessionProvider");
  return v;
}

export function SessionProvider({ config, children, apiOverride }: { config: AppConfig; children: React.ReactNode; apiOverride?: Api }) {
  const locale = useMemo(() => deviceLocale(), []);
  const t = useMemo(() => translator(locale), [locale]);
  const api = useMemo(() => apiOverride ?? new Api(config, locale), [apiOverride, config, locale]);
  const [status, setStatus] = useState<AuthStatus>("restoring");
  const [me, setMe] = useState<Me | null>(null);
  const [offlineSubject, setOfflineSubject] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<ReadonlySet<string>>(new Set());
  const [favoritesVersion, setFavoritesVersion] = useState(0);
  const discovery = useRef<DiscoveryDocument | null>(null);
  const session = useRef<Session | null>(null);
  const hydrated = useRef(false);
  // One refresh at a time: the realm rotates refresh tokens with no reuse, so two concurrent refreshes
  // with the same stored token would get one of them refused and sign the customer out.
  const refreshing = useRef<Promise<Session | null> | null>(null);

  const getDiscovery = useCallback(async () => {
    discovery.current = await ensureDiscovery(discovery.current, () => discover(config));
    return discovery.current;
  }, [config]);

  const refreshOnce = useCallback((): Promise<Session | null> => {
    refreshing.current ??= (async () => refresh(await getDiscovery()))().finally(() => { refreshing.current = null; });
    return refreshing.current;
  }, [getDiscovery]);

  const becomeGuest = useCallback(() => {
    session.current = null;
    hydrated.current = false;
    setMe(null);
    setOfflineSubject(null);
    setFavorites(new Set());
    setStatus("guest");
  }, []);

  const loadFavorites = useCallback(async (token: string) => {
    const ids = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await api.listFavorites(token, cursor);
      page.items.forEach((p) => ids.add(p.id));
      cursor = page.nextCursor;
    } while (cursor);
    setFavorites(ids);
    hydrated.current = true;
    setFavoritesVersion((v) => v + 1);
  }, [api]);

  const establish = useCallback(async (s: Session) => {
    session.current = s;
    const who = await fetchMe(config, s);
    setMe(who);
    setOfflineSubject(null);
    setStatus("signedIn");
    rememberSubject(who.subject).catch(() => undefined);
    // Favorites failing to load must not sign the customer out; the Favorites tab shows its own error.
    loadFavorites(s.accessToken).catch(() => undefined);
  }, [config, loadFavorites]);

  // Silent restore at launch: a stored refresh token signs the customer back in; anything else is a guest.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await refreshOnce();
        if (cancelled) return;
        if (s) await establish(s);
        else becomeGuest();
      } catch {
        // Offline at launch: browse as guest (signing in retries discovery), but keep the stored
        // account's local designs reachable.
        if (cancelled) return;
        becomeGuest();
        const subject = await rememberedSubject().catch(() => null);
        if (!cancelled) setOfflineSubject(subject);
      }
    })();
    return () => { cancelled = true; };
  }, [refreshOnce, establish, becomeGuest]);

  const signIn = useCallback(async () => {
    setStatus("signingIn");
    try {
      const s = await browserSignIn(await getDiscovery());
      if (s) await establish(s);
      else setStatus(session.current ? "signedIn" : "guest"); // the person closed the browser
    } catch {
      setStatus("failed");
    }
  }, [getDiscovery, establish]);

  const signOut = useCallback(async () => {
    const doc = discovery.current;
    becomeGuest();
    if (doc) await revoke(doc).catch(() => undefined);
  }, [becomeGuest]);

  const token = useCallback(async (): Promise<string> => {
    if (isFresh(session.current)) return session.current.accessToken;
    const s = await refreshOnce().catch(() => { throw new ApiError("offline"); });
    if (!s) {
      becomeGuest();
      throw new ApiError("unauthenticated");
    }
    const restoring = !session.current;
    session.current = s;
    // Launched offline and the connection is back: finish signing in (profile, favorites).
    if (restoring) establish(s).catch(() => undefined);
    return s.accessToken;
  }, [refreshOnce, becomeGuest, establish]);

  const withToken = useCallback(async <T,>(fn: (token: string) => Promise<T>): Promise<T> => {
    try {
      return await fn(await token());
    } catch (err) {
      if (!(err instanceof ApiError) || err.kind !== "unauthenticated" || !session.current) throw err;
      session.current = { ...session.current, expiresAt: 0 }; // force one refresh, then give up
      return fn(await token());
    }
  }, [token]);

  const ensureFavorites = useCallback(async () => {
    if (!session.current || hydrated.current) return;
    await withToken((tok) => loadFavorites(tok)).catch(() => undefined);
  }, [withToken, loadFavorites]);

  const setFavorite = useCallback(async (id: string, saved: boolean): Promise<FavoriteResult> => {
    if (!session.current) return "needsSignIn";
    const was = favorites.has(id);
    const apply = (on: boolean) => setFavorites((prev) => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
    apply(saved); // optimistic; rolled back on failure
    try {
      await withToken((tok) => api.setFavorite(tok, id, saved));
      setFavoritesVersion((v) => v + 1);
      return saved ? "saved" : "removed";
    } catch (err) {
      apply(was);
      return err instanceof ApiError && err.kind === "unauthenticated" ? "needsSignIn" : "failed";
    }
  }, [favorites, withToken, api]);

  const localOwner = status === "signedIn" ? me?.subject ?? null : offlineSubject;
  const value = useMemo<SessionValue>(() => ({
    config, locale, t, api, status, me, localOwner, signIn, signOut, withToken, favorites, favoritesVersion, ensureFavorites, setFavorite,
  }), [config, locale, t, api, status, me, localOwner, signIn, signOut, withToken, favorites, favoritesVersion, ensureFavorites, setFavorite]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
