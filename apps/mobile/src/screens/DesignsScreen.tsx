import { useCallback, useEffect, useState } from "react";
import { FlatList, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { ApiError } from "../api";
import { useDesign } from "../design/DesignContext";
import { familyName } from "../design/describe";
import type { LocalProject, OutboxEntry } from "../design/store";
import { useSession } from "../session";
import { FamilyArt } from "../design/art";
import { Button, c, errorKey, fonts, LINING, Header, Loading, Notice, s, styles, type } from "../ui";

type Row = LocalProject & { pending: number; problems: number; thumb: string | null };
type State = { phase: "loading" } | { phase: "ready"; rows: Row[]; refreshed: boolean; error: ApiError | null };

const MAX_PAGES = 5;

export function DesignsScreen({ onOpen, onNew }: { onOpen: (id: string) => void; onNew: () => void }) {
  const { t, locale, status, signIn, localOwner } = useSession();
  const { store, sync, client, connectivity, version, saw, ready } = useDesign();
  const [state, setState] = useState<State>({ phase: "loading" });

  const readLocal = useCallback(async (): Promise<Row[]> => {
    if (!store) return [];
    const [projects, outbox] = await Promise.all([store.projects(), store.outbox()]);
    const count = (id: string, f: (e: OutboxEntry) => boolean) => outbox.filter((e) => e.op.projectId === id && f(e)).length;
    // A picture from the viewer only while it still shows the current revision; otherwise the family render.
    const thumbs = await Promise.all(projects.map((p) => store.thumb(p.project.id).catch(() => null)));
    return projects.map((p, i) => ({
      ...p, pending: count(p.project.id, (e) => e.status === "PENDING"), problems: count(p.project.id, (e) => e.status !== "PENDING"),
      thumb: thumbs[i]?.revisionId === p.head.id ? thumbs[i]!.jpeg : null,
    }));
  }, [store]);

  const load = useCallback(async () => {
    if (!store || !sync) return;
    setState({ phase: "ready", rows: await readLocal(), refreshed: false, error: null }); // what the phone has, at once
    try {
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page = await client.listProjects(cursor);
        for (const p of page.items) {
          const local = await store.project(p.id);
          if (local?.head.id !== p.headRevisionId) await store.putProject({ project: p, head: await client.getRevision(p.id, p.headRevisionId) });
          else if (local) await store.putProject({ ...local, project: p });
        }
        cursor = page.nextCursor;
      } while (cursor && ++pages < MAX_PAGES);
      saw(undefined);
      setState({ phase: "ready", rows: await readLocal(), refreshed: true, error: null });
    } catch (e) {
      saw(e);
      const error = e instanceof ApiError ? e : new ApiError("unexpected");
      setState({ phase: "ready", rows: await readLocal(), refreshed: false, error });
    }
  }, [store, sync, client, readLocal, saw]);

  useEffect(() => { void load(); }, [load]);
  // Back online (a sync or another screen reached the API): fetch again, so the list and the banner
  // stop saying "offline" without waiting for a change of tab.
  const lostConnection = state.phase === "ready" && state.error?.kind === "offline";
  useEffect(() => { if (connectivity === "online" && lostConnection) void load(); }, [connectivity, lostConnection, load]);
  useEffect(() => { if (state.phase === "ready") void readLocal().then((rows) => setState((s0) => (s0.phase === "ready" ? { ...s0, rows } : s0))); },
    [version]);

  const header = <Header title={t("designsTitle")} subtitle={t("designsSubtitle")} />;
  if (status === "restoring") return <View style={styles.screen}>{header}<Loading label={t("restoring")} /></View>;
  if (!localOwner) {
    return (
      <View style={styles.screen}>
        {header}
        <Notice message={t("designsGuest")} action={{ label: t("signIn"), onPress: signIn }} />
      </View>
    );
  }
  if (!ready || state.phase === "loading") return <View style={styles.screen}>{header}<Loading label={t("loadingDesigns")} /></View>;

  const offline = connectivity === "offline" || (connectivity !== "online" && state.error?.kind === "offline");
  const empty = state.rows.length === 0;
  return (
    <View style={styles.screen}>
      {header}
      {offline && <Text accessibilityRole="alert" style={styles.banner}>{t("offlineBanner")}</Text>}
      {!offline && state.error && empty && <Notice alert message={t(errorKey(state.error))} action={{ label: t("retry"), onPress: load }} />}
      {empty && !state.error && state.refreshed && <Notice message={t("designsEmpty")} action={{ label: t("newDesign"), onPress: onNew }} />}
      {empty && offline && <Notice message={t("designsEmptyOffline")} />}
      {!empty && (
        <FlatList
          data={state.rows}
          keyExtractor={(r) => r.project.id}
          contentContainerStyle={list.content}
          ListHeaderComponent={<Button label={t("newDesign")} onPress={onNew} />}
          renderItem={({ item }) => {
            const lines = [familyName(item.project.familyId, locale), t("revisionLine", { number: String(item.head.number) })];
            if (item.pending) lines.push(item.pending === 1 ? t("pendingOne") : t("pendingCount", { count: String(item.pending) }));
            if (item.problems) lines.push(t("needsDecision"));
            return (
              <Pressable accessibilityRole="button" accessibilityLabel={[item.project.title, ...lines].join(", ")}
                onPress={() => onOpen(item.project.id)} style={({ pressed }) => [list.row, pressed && { opacity: 0.7 }]}>
                {item.thumb
                  ? <Image testID="design-thumb" source={{ uri: item.thumb }} style={[list.thumb, list.shot]} accessibilityIgnoresInvertColors />
                  : <FamilyArt familyId={item.project.familyId} materialId={item.head.document.components[0]?.materialId ?? ""} label="" style={list.thumb} />}
                <View style={list.body}>
                  <Text style={list.kind}>{lines[0]}</Text>
                  <Text style={list.title} numberOfLines={2}>{item.project.title}</Text>
                  <Text style={styles.muted}>{lines[1]}</Text>
                  {item.pending > 0 && <Text style={[styles.muted, { color: c.info }]}>{lines[2]}</Text>}
                  {item.problems > 0 && <Text style={[styles.muted, { color: c.warning }]}>{t("needsDecision")}</Text>}
                </View>
                <Text style={list.chevron}>›</Text>
              </Pressable>
            );
          }}
        />
      )}
      {empty && !offline && !state.error && !state.refreshed && <Loading label={t("loadingDesigns")} />}
    </View>
  );
}

const list = StyleSheet.create({
  content: { padding: s[4], gap: s[3] },
  row: {
    backgroundColor: c.surface, borderRadius: 12, padding: s[2], gap: s[3], minHeight: 64, flexDirection: "row", alignItems: "center",
    borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(197,160,89,0.22)",
  },
  thumb: { width: 88, borderRadius: 8 },
  shot: { aspectRatio: 1, backgroundColor: "#141416" },
  body: { flex: 1, gap: 2 },
  kind: { color: c.textMuted, fontSize: type[0], letterSpacing: 1.2, textTransform: "uppercase" },
  title: { color: c.text, fontSize: type[3], fontFamily: fonts.display, fontVariant: LINING },
  chevron: { color: c.accent, fontSize: type[4], paddingHorizontal: s[1] },
});
