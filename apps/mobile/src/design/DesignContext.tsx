// Design state shared by the design screens: the phone's store for the signed-in customer, the sync
// engine and whether the API answered last time. Pending offline changes are sent when the app opens,
// when it comes back to the foreground, after each change and every 30 s while any are waiting.
import { randomUUID } from "expo-crypto";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import { ApiError } from "../api";
import { useSession } from "../session";
import { DesignClient } from "./client";
import { openDatabaseAsync } from "expo-sqlite";
import { SqliteDesignStore, type DesignStore } from "./store";
import { DesignSync, type FlushOutcome } from "./sync";

export type Connectivity = "unknown" | "online" | "offline";
export type OpenStore = (owner: string) => Promise<DesignStore>;

interface DesignValue {
  ready: boolean;
  store: DesignStore | null;
  sync: DesignSync | null;
  client: DesignClient;
  connectivity: Connectivity;
  /** Changes whenever the store changed (sync result, refresh, new change): screens reload on it. */
  version: number;
  bump(): void;
  /** Report the outcome of any API call so the offline banner stays truthful. */
  saw(e: unknown): void;
  syncNow(): Promise<FlushOutcome>;
  newId(): string;
}

const Ctx = createContext<DesignValue | null>(null);
export const RETRY_MS = 30_000;

export function useDesign(): DesignValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useDesign outside DesignProvider");
  return v;
}

async function openSqlite(owner: string): Promise<DesignStore> {
  return SqliteDesignStore.open(await openDatabaseAsync("aurea-design.db"), owner);
}

export function DesignProvider({ children, openStore = openSqlite, newId = randomUUID }: {
  children: React.ReactNode; openStore?: OpenStore; newId?: () => string;
}) {
  const { api, withToken, localOwner } = useSession();
  const client = useMemo(() => new DesignClient(api, withToken), [api, withToken]);
  const [store, setStore] = useState<DesignStore | null>(null);
  const [connectivity, setConnectivity] = useState<Connectivity>("unknown");
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const owner = localOwner;

  useEffect(() => {
    let cancelled = false;
    setStore(null);
    if (!owner) return;
    openStore(owner).then((s) => { if (!cancelled) setStore(s); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [owner, openStore]);

  const sync = useMemo(() => (store ? new DesignSync(store, client, newId) : null), [store, client, newId]);

  const saw = useCallback((e: unknown) => {
    if (e === undefined) setConnectivity("online");
    else if (e instanceof ApiError && e.kind === "offline") setConnectivity("offline");
    else if (e instanceof ApiError) setConnectivity("online"); // the API answered, even if with an error
  }, []);

  const syncNow = useCallback(async (): Promise<FlushOutcome> => {
    if (!sync) return { state: "idle" };
    const r = await sync.flush();
    if (r.state === "offline") setConnectivity("offline");
    else if (r.state === "done" || r.state === "idle") setConnectivity((c) => (r.state === "done" ? "online" : c));
    if (r.state === "done") bump();
    return r;
  }, [sync, bump]);

  // Opening, returning to the foreground and a slow retry while something waits.
  const latest = useRef(syncNow);
  latest.current = syncNow;
  useEffect(() => {
    if (!sync) return;
    void latest.current();
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") void latest.current(); });
    const timer = setInterval(() => {
      void store?.outbox().then((all) => { if (all.some((e) => e.status === "PENDING")) void latest.current(); });
    }, RETRY_MS);
    return () => { sub.remove(); clearInterval(timer); };
  }, [sync, store]);

  const value = useMemo<DesignValue>(() => ({
    ready: !!store, store, sync, client, connectivity, version, bump, saw, syncNow, newId,
  }), [store, sync, client, connectivity, version, bump, saw, syncNow, newId]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
