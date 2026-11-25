import tokens from "@aurea/tokens";
import { applyOperation, family as familyOf, MATERIALS, type Issue } from "@aurea/design";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ApiError } from "../api";
import { useDesign } from "../design/DesignContext";
import { alloyColor, alloyName, describeIssue, describeOp, familyName, mm, paramLabel, parseMm } from "../design/describe";
import { GlbIntegrityError, loadGlb, waitForJob } from "../design/glb";
import type { Draft } from "../design/sync";
import type { DesignOperation, Job } from "../design/types";
import { Viewer } from "../design/viewer/Viewer";
import { formatDecimal } from "../format";
import { useSession } from "../session";
import { Button, c, Header, Loading, Notice, s, styles, type } from "../ui";

type Preview =
  | { phase: "none" }
  | { phase: "computing" }
  | { phase: "failed"; code: string }
  | { phase: "offline" }
  // `mesh` is this preview's own verified GLB (null if it could not be loaded: the metrics stand alone).
  // `attempt` is fixed on the first Accept so a retry after a lost answer reuses its idempotency key.
  | { phase: "ready"; job: Job; op: DesignOperation; mesh: string | null }
  | { phase: "accepting"; job: Job; op: DesignOperation; mesh: string | null; attempt: Attempt }
  | { phase: "acceptFailed"; job: Job; op: DesignOperation; mesh: string | null; attempt: Attempt; conflict: boolean };
interface Attempt { key: string; baseRevisionId: string }

const STEP = 0.1;
const round = (v: number) => Math.round(v * 1000) / 1000;

export function EditorScreen({ id, onBack }: { id: string; onBack: () => void }) {
  const { t, locale } = useSession();
  const { store, sync, client, connectivity, version, bump, saw, syncNow, newId } = useDesign();
  const [draft, setDraft] = useState<Draft | null | "loading">("loading");
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [op, setOp] = useState<DesignOperation | null>(null);
  const [issue, setIssue] = useState<{ name: string; issue: Issue } | null>(null);
  const [preview, setPreview] = useState<Preview>({ phase: "none" });
  const [glb, setGlb] = useState<string | null>(null);
  // Why there is no mesh yet: being built, no connection, or the build failed. Never "offline" while building.
  const [mesh, setMesh] = useState<"building" | "offline" | "failed">("building");
  const [syncing, setSyncing] = useState<"idle" | "busy" | "offline">("idle");
  const alive = useRef({ aborted: false });
  useEffect(() => () => { alive.current.aborted = true; }, []);

  const reload = useCallback(async () => {
    if (!sync) return;
    let d = await sync.draft(id);
    if (!d) {
      try { await sync.refresh(id); saw(undefined); d = await sync.draft(id); } catch (e) { saw(e); }
    }
    setDraft(d);
  }, [sync, id, saw]);
  useEffect(() => { void reload(); }, [reload, version]);

  const local = draft && draft !== "loading" ? draft : null;
  const comp = local?.document.components[0];
  const fam = local ? familyOf(local.local.project.familyId) : undefined;

  // Text fields follow the draft until the person types.
  useEffect(() => {
    if (!comp) return;
    setTexts(Object.fromEntries(Object.entries(comp.parameters).map(([k, v]) => [k, formatDecimal(String(v), "", locale).trim()])));
    setOp(null);
    setIssue(null);
  }, [comp, locale]);

  // Geometry of the head: the phone's copy first, then the server's (reused for the same digest).
  const headDigest = local?.local.head.digest;
  const headId = local?.local.head.id;
  useEffect(() => {
    if (!store || !headDigest || !headId || preview.phase === "ready") return;
    let cancelled = false;
    (async () => {
      const cached = await store.glb(headDigest);
      if (cancelled) return;
      if (cached) { setGlb(cached); return; }
      setGlb(null);
      setMesh("building");
      try {
        const job = await waitForJob(client, (await client.buildRevision(headId, newId())).id, { signal: alive.current });
        if (cancelled) return;
        if (job.state === "SUCCEEDED") setGlb(await loadGlb(client, job, { store, cacheKey: headDigest }));
        else setMesh("failed");
        saw(undefined);
      } catch (e) {
        saw(e);
        if (!cancelled) setMesh(e instanceof ApiError && e.kind === "offline" ? "offline" : "failed");
      }
    })();
    return () => { cancelled = true; };
  }, [store, client, headDigest, headId, newId, saw, preview.phase]);

  const propose = (next: DesignOperation, name: string) => {
    if (!local) return;
    setPreview({ phase: "none" });
    const r = applyOperation(local.document, next);
    if (!r.ok) {
      setOp(null);
      setIssue({ name, issue: r.issues[0] });
      return;
    }
    setIssue(null);
    setOp(next);
  };
  const setParam = (name: string, value: number) => propose({ type: "modify_parameter", componentId: comp!.id, name, value }, name);

  if (draft === "loading" || !sync) return <View style={styles.screen}><Header title="" onBack={onBack} backLabel={t("back")} /><Loading label={t("loadingDesigns")} /></View>;
  if (!local || !comp || !fam) {
    return (
      <View style={styles.screen}>
        <Header title="" onBack={onBack} backLabel={t("back")} />
        <Notice alert message={t("designNotOnPhone")} action={{ label: t("retry"), onPress: reload }} />
      </View>
    );
  }

  const blocked = local.pending.length > 0 || local.problems.length > 0;
  const offline = connectivity === "offline";
  const busy = preview.phase === "computing" || preview.phase === "accepting";

  const runPreview = async () => {
    if (!op) return;
    setPreview({ phase: "computing" });
    try {
      const queued = await client.proposeOperation(id, local.local.head.id, op, newId());
      const job = await waitForJob(client, queued.id, { signal: alive.current });
      saw(undefined);
      if (job.state !== "SUCCEEDED") { setPreview({ phase: "failed", code: job.errorCode ?? job.state }); return; }
      // The mesh is loaded and verified before Accept is offered, so an accepted revision is never
      // cached with the previous head's geometry.
      const mesh = await loadGlb(client, job).catch((err) => { if (err instanceof GlbIntegrityError) throw err; return null; });
      if (mesh) setGlb(mesh);
      setPreview({ phase: "ready", job, op, mesh });
    } catch (e) {
      saw(e);
      if (e instanceof ApiError && e.kind === "offline") setPreview({ phase: "offline" });
      else if (e instanceof ApiError && (e.kind === "conflict" || e.code === "VERSION_CONFLICT")) { setPreview({ phase: "failed", code: "VERSION_CONFLICT" }); await sync.refresh(id).catch(() => undefined); bump(); }
      else setPreview({ phase: "failed", code: e instanceof ApiError ? e.details[0]?.code ?? e.code ?? e.kind : e instanceof GlbIntegrityError ? "GLB_INTEGRITY" : "UNEXPECTED" });
    }
  };

  const accept = async () => {
    if (preview.phase !== "ready" && preview.phase !== "acceptFailed") return;
    const { job, op: accepted, mesh } = preview;
    const attempt = preview.phase === "acceptFailed" ? preview.attempt : { key: newId(), baseRevisionId: local.local.head.id };
    setPreview({ phase: "accepting", job, op: accepted, mesh, attempt });
    try {
      const rev = await client.acceptPreview(id, attempt.baseRevisionId, job.id, attempt.key);
      const project = await client.getProject(id);
      await store?.putProject({ project, head: rev });
      if (mesh) await store?.putGlb(rev.digest, mesh);
      saw(undefined);
      setPreview({ phase: "none" });
      bump();
    } catch (e) {
      saw(e);
      setPreview({ phase: "acceptFailed", job, op: accepted, mesh, attempt, conflict: e instanceof ApiError && e.kind === "conflict" });
    }
  };

  const saveOffline = async () => {
    if (!op) return;
    const r = await sync.saveOffline(id, op);
    if (!r.ok) { setIssue({ name: op.type === "modify_parameter" ? String(op.name) : "materialId", issue: r.issues[0] }); return; }
    setPreview({ phase: "none" });
    bump();
    void syncNow();
  };

  const sendNow = async () => {
    setSyncing("busy");
    const r = await syncNow();
    setSyncing(r.state === "offline" ? "offline" : "idle");
  };

  const summary = preview.phase === "ready" || preview.phase === "accepting" || preview.phase === "acceptFailed" ? preview.job.summary : null;
  const metrics = summary?.components[0];
  const title = local.local.project.title;
  const revLine = t("revisionLine", { number: String(local.local.head.number) })
    + (local.pending.length ? ` · ${local.pending.length === 1 ? t("pendingOne") : t("pendingCount", { count: String(local.pending.length) })}` : "");

  return (
    <View style={styles.screen}>
      <Header title={title} subtitle={`${familyName(fam.id, locale)} · ${revLine}`} onBack={onBack} backLabel={t("back")} />
      {offline && <Text accessibilityRole="alert" style={styles.banner}>{t("offlineBanner")}</Text>}
      <ScrollView contentContainerStyle={ed.content} keyboardShouldPersistTaps="handled">
        <Viewer glb={glb} color={alloyColor(comp.materialId)} label={t("viewerLabel", { name: title })}
          emptyText={t(mesh === "building" ? "viewerBuilding" : mesh === "offline" ? "viewerEmpty" : "viewerBuildFailed")} errorText={t("viewerError")} loadingText={t("viewerLoading")} />
        <Text style={styles.muted}>{t("previewNote")}</Text>

        {local.problems.length > 0 && (
          <View style={ed.card}>
            {local.problems.map((e) => (
              <View key={e.op.id} style={{ gap: s[2] }}>
                <Text accessibilityRole="alert" style={[styles.body, { color: c.warning }]}>
                  {e.status === "CONFLICT"
                    ? t("conflictItem", { change: describeOp(e.op.operation, fam.id, locale, t) })
                    : t("rejectedItem", { change: describeOp(e.op.operation, fam.id, locale, t), code: e.error?.code ?? "?" })}
                </Text>
                {e.status === "CONFLICT" && (
                  <Button label={t("retryOnLatest")} onPress={async () => {
                    const r = await sync.retryOnLatest(e.op.id).catch((err: unknown) => { saw(err); return null; });
                    if (r) { bump(); void syncNow(); }
                  }} />
                )}
                <Button variant="secondary" label={t("discardChange")} onPress={async () => { await sync.discard(e.op.id); bump(); }} />
              </View>
            ))}
            {local.pending.length > 0 && <Text style={styles.muted}>{t("waitingBehind")}</Text>}
          </View>
        )}

        {local.pending.length > 0 && (
          <View style={ed.card}>
            <Text accessibilityRole="header" style={ed.h}>{t("pendingTitle")}</Text>
            {local.pending.map((e) => <Text key={e.op.id} style={styles.body}>{t("pendingItem", { change: describeOp(e.op.operation, fam.id, locale, t) })}</Text>)}
            <Button variant="secondary" label={syncing === "busy" ? t("syncing") : t("syncNow")} disabled={syncing === "busy"} onPress={sendNow} />
            {syncing === "offline" && <Text accessibilityRole="alert" style={styles.muted}>{t("syncOffline")}</Text>}
          </View>
        )}

        <Text accessibilityRole="header" style={ed.h}>{t("parameters")}</Text>
        {fam.parameters.map((p) => {
          const label = p.label[locale];
          const current = Number(comp.parameters[p.name]);
          const shown = op?.type === "modify_parameter" && op.name === p.name ? Number(op.value) : current;
          const err = issue?.name === p.name ? describeIssue(issue.issue, fam.id, p.name, locale, t) : null;
          return (
            <View key={p.name} style={ed.param}>
              <View style={ed.paramHead}>
                <Text style={styles.body}>{label}</Text>
                <Text style={styles.muted}>{t("range", { min: formatDecimal(String(p.min), "", locale).trim(), max: formatDecimal(String(p.max), "", locale).trim() })}</Text>
              </View>
              <View style={ed.stepper}>
                <Pressable accessibilityRole="button" accessibilityLabel={t("decrease", { name: label })} disabled={busy}
                  onPress={() => { const v = round(shown - STEP); setTexts((x) => ({ ...x, [p.name]: formatDecimal(String(v), "", locale).trim() })); setParam(p.name, v); }}
                  style={ed.step}><Text style={ed.stepText}>−</Text></Pressable>
                <TextInput
                  value={texts[p.name] ?? ""}
                  onChangeText={(v) => setTexts((x) => ({ ...x, [p.name]: v }))}
                  onEndEditing={() => setParam(p.name, parseMm(texts[p.name] ?? ""))}
                  onSubmitEditing={() => setParam(p.name, parseMm(texts[p.name] ?? ""))}
                  keyboardType="decimal-pad"
                  accessibilityLabel={t("valueInput", { name: label })}
                  accessibilityHint={t("range", { min: String(p.min), max: String(p.max) })}
                  editable={!busy}
                  style={[ed.input, err && { borderColor: c.danger }]}
                />
                <Text style={styles.muted}>mm</Text>
                <Pressable accessibilityRole="button" accessibilityLabel={t("increase", { name: label })} disabled={busy}
                  onPress={() => { const v = round(shown + STEP); setTexts((x) => ({ ...x, [p.name]: formatDecimal(String(v), "", locale).trim() })); setParam(p.name, v); }}
                  style={ed.step}><Text style={ed.stepText}>+</Text></Pressable>
              </View>
              {err && <Text accessibilityRole="alert" style={[styles.muted, { color: c.danger }]}>{err}</Text>}
            </View>
          );
        })}

        <Text accessibilityRole="header" style={ed.h}>{t("alloy")}</Text>
        <View accessibilityRole="radiogroup" style={ed.chips}>
          {MATERIALS.map((m) => {
            const chosen = op?.type === "change_material" ? op.materialId === m.id : comp.materialId === m.id;
            return (
              <Pressable key={m.id} accessibilityRole="radio" accessibilityState={{ selected: chosen, disabled: busy }} accessibilityLabel={m.name[locale]}
                disabled={busy} onPress={() => propose({ type: "change_material", componentId: comp.id, materialId: m.id }, "materialId")}
                style={[ed.chip, chosen && { borderColor: c.accent }]}>
                <View style={[ed.swatch, { backgroundColor: alloyColor(m.id) }]} />
                <Text style={[styles.muted, chosen && { color: c.accent }]}>{m.name[locale]}</Text>
              </Pressable>
            );
          })}
        </View>
        {issue?.name === "materialId" && <Text accessibilityRole="alert" style={[styles.muted, { color: c.danger }]}>{describeIssue(issue.issue, fam.id, "", locale, t)}</Text>}

        {op && preview.phase === "none" && (
          <View style={ed.card}>
            <Text style={styles.body}>{describeOp(op, fam.id, locale, t)}</Text>
            {!blocked && !offline && <Button label={t("preview")} onPress={runPreview} />}
            {blocked && !offline && <Text style={styles.muted}>{t("previewNeedsSync")}</Text>}
            {(offline || blocked) && (
              <>
                <Button variant={offline ? "primary" : "secondary"} label={t("saveOffline")} onPress={saveOffline} />
                <Text style={styles.muted}>{t("saveOfflineHint")}</Text>
              </>
            )}
          </View>
        )}
        {preview.phase === "computing" && <Loading label={t("previewing")} />}
        {preview.phase === "offline" && op && (
          <View style={ed.card}>
            <Text accessibilityRole="alert" style={styles.body}>{t("offerOffline")}</Text>
            <Button label={t("saveOffline")} onPress={saveOffline} />
          </View>
        )}
        {preview.phase === "failed" && (
          <Text accessibilityRole="alert" style={[styles.body, { color: c.danger }]}>
            {preview.code === "VERSION_CONFLICT" ? t("acceptConflict") : t("previewFailed", { code: preview.code })}
          </Text>
        )}
        {summary && metrics && (
          <View style={ed.card} accessibilityLabel={t("previewTitle")}>
            <Text accessibilityRole="header" style={ed.h}>{t("previewTitle")}</Text>
            {summary.changes.map((ch) => (
              <Text key={ch.name} style={styles.body}>
                {ch.name === "materialId"
                  ? `${t("material")}: ${alloyName(String(ch.from), locale)} → ${alloyName(String(ch.to), locale)}`
                  : `${paramLabel(fam.id, ch.name, locale)}: ${mm(Number(ch.from), locale)} → ${mm(Number(ch.to), locale)}`}
              </Text>
            ))}
            <Metric k={t("metricVolume")} v={formatDecimal(metrics.volumeMm3, "mm³", locale)} />
            <Metric k={t("metricMass")} v={formatDecimal(metrics.massGramsEstimate, "g", locale)} />
            <Text style={styles.muted}>{t("metricMassNote")}</Text>
            <Metric k={t("metricSize")} v={metrics.boundingBoxMm.map((x) => formatDecimal(String(x), "", locale).trim()).join(" × ") + " mm"} />
            <Metric k={t("metricWall")} v={mm(metrics.minWallMm, locale)} />
            <Text style={[styles.body, { color: c.warning }]}>{t("dfmReview")}</Text>
            <Button label={preview.phase === "accepting" ? t("accepting") : t("accept")} disabled={preview.phase === "accepting"} onPress={accept} />
            <Button variant="secondary" label={t("discardPreview")} disabled={preview.phase === "accepting"} onPress={() => {
              setPreview({ phase: "none" });
              setOp(null);
              setTexts(Object.fromEntries(Object.entries(comp.parameters).map(([k, v]) => [k, formatDecimal(String(v), "", locale).trim()])));
              void store?.glb(local.local.head.digest).then(setGlb);
            }} />
            {preview.phase === "acceptFailed" && (
              <Text accessibilityRole="alert" style={[styles.body, { color: c.danger }]}>{t(preview.conflict ? "acceptConflict" : "acceptFailed")}</Text>
            )}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function Metric({ k, v }: { k: string; v: string }) {
  return (
    <View style={ed.metric} accessible accessibilityLabel={`${k}: ${v}`}>
      <Text style={styles.muted}>{k}</Text>
      <Text style={styles.body}>{v}</Text>
    </View>
  );
}

const ed = StyleSheet.create({
  content: { padding: s[4], gap: s[3], paddingBottom: s[6] },
  h: { color: c.text, fontSize: type[3], fontWeight: "600" },
  card: { backgroundColor: c.surface, borderRadius: 12, padding: s[3], gap: s[2] },
  param: { gap: s[1] },
  paramHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  stepper: { flexDirection: "row", alignItems: "center", gap: s[2] },
  step: {
    width: tokens.touchTargetDp, height: tokens.touchTargetDp, borderRadius: tokens.radius[0], borderWidth: 1, borderColor: c.inputBorder,
    alignItems: "center", justifyContent: "center",
  },
  stepText: { color: c.accent, fontSize: type[4] },
  input: {
    flex: 1, minHeight: tokens.touchTargetDp, borderWidth: 1, borderColor: c.inputBorder, borderRadius: tokens.radius[0],
    color: c.text, paddingHorizontal: s[3], fontSize: type[2], textAlign: "center",
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: s[2] },
  chip: {
    minHeight: tokens.touchTargetDp, flexDirection: "row", alignItems: "center", gap: s[1], paddingHorizontal: s[3],
    borderRadius: tokens.radius[0], borderWidth: 1, borderColor: c.inputBorder,
  },
  swatch: { width: 14, height: 14, borderRadius: 7 },
  metric: { flexDirection: "row", justifyContent: "space-between" },
});
