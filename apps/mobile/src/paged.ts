// Keyset-paged list state for the catalog and favorites. A failed first load is an error state (never an
// empty list); a failed next page keeps what is shown and offers to retry that page only.
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, type ProductPage, type ProductSummary } from "./api";

export type PagedState =
  | { phase: "loading" }
  | { phase: "error"; error: ApiError }
  | { phase: "ready"; items: ProductSummary[]; nextCursor: string | null; more: "idle" | "loading" | "failed"; refreshing: boolean };

const asApiError = (e: unknown) => (e instanceof ApiError ? e : new ApiError("unexpected"));

export function mergePage(items: ProductSummary[], page: ProductPage): ProductSummary[] {
  const seen = new Set(items.map((p) => p.id));
  return [...items, ...page.items.filter((p) => !seen.has(p.id))];
}

export function usePaged(load: (cursor: string | null) => Promise<ProductPage>, key: string) {
  const [state, setState] = useState<PagedState>({ phase: "loading" });
  const generation = useRef(0); // ignores answers to a superseded request (filter changed meanwhile)

  const first = useCallback(async (refreshing = false) => {
    const g = ++generation.current;
    setState((prev) => (refreshing && prev.phase === "ready" ? { ...prev, refreshing: true } : { phase: "loading" }));
    try {
      const page = await load(null);
      if (g === generation.current) setState({ phase: "ready", items: page.items, nextCursor: page.nextCursor, more: "idle", refreshing: false });
    } catch (e) {
      if (g !== generation.current) return;
      // A failed pull-to-refresh keeps the list it had; only a first load turns into the error state.
      setState((prev) => (prev.phase === "ready" ? { ...prev, refreshing: false, more: "idle" } : { phase: "error", error: asApiError(e) }));
    }
  }, [load]);

  useEffect(() => { void first(); }, [first, key]);

  const loadMore = useCallback(async () => {
    if (state.phase !== "ready" || !state.nextCursor || state.more === "loading") return;
    const g = generation.current;
    const cursor = state.nextCursor;
    setState({ ...state, more: "loading" });
    try {
      const page = await load(cursor);
      if (g === generation.current) setState((prev) => prev.phase === "ready"
        ? { ...prev, items: mergePage(prev.items, page), nextCursor: page.nextCursor, more: "idle" } : prev);
    } catch {
      if (g === generation.current) setState((prev) => (prev.phase === "ready" ? { ...prev, more: "failed" } : prev));
    }
  }, [state, load]);

  return { state, reload: () => first(false), refresh: () => first(true), loadMore };
}
