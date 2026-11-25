import tokens from "@aurea/tokens";
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { ApiError } from "../api";
import { useDesign } from "../design/DesignContext";
import { alloyName, mm, paramLabel } from "../design/describe";
import type { AiProposal, AiProposalOption, AiQuota } from "../design/types";
import { useSession } from "../session";
import { Button, c, fonts, Loading, s, styles, type } from "../ui";
import { ChangeLine } from "./commerce-ui";

type Ask =
  | { phase: "idle" }
  | { phase: "asking"; key: string; prompt: string }
  | { phase: "failed"; key: string; prompt: string; code: string }
  | { phase: "done"; proposal: AiProposal };

/**
 * AURA in the editor (hito 400). The person writes what they want; AURA answers with up to three
 * options that change nothing. "Ver vista previa" hands one option to the editor, which shows the
 * real geometry and asks for the explicit acceptance that creates the revision.
 */
export function AuraPanel({ projectId, baseRevisionId, familyId, disabled, previewing, onPreview }: {
  projectId: string;
  baseRevisionId: string;
  familyId: string;
  /** No connection or changes waiting to sync: AURA needs the server's current revision. */
  disabled: "offline" | "pending" | null;
  previewing: number | null;
  onPreview: (proposal: AiProposal, option: AiProposalOption) => void;
}) {
  const { t, locale } = useSession();
  const { client, newId, saw } = useDesign();
  const [text, setText] = useState("");
  const [ask, setAsk] = useState<Ask>({ phase: "idle" });
  const [quota, setQuota] = useState<AiQuota | null>(null);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  const loadQuota = useCallback(async () => {
    try { const q = await client.getAiQuota(); if (live.current) setQuota(q); } catch { /* the quota line is optional */ }
  }, [client]);
  useEffect(() => { if (!disabled) void loadQuota(); }, [disabled, loadQuota]);
  // A proposal belongs to the revision it was made on: a new head makes it stale.
  useEffect(() => { setAsk((a) => (a.phase === "done" && a.proposal.baseRevisionId !== baseRevisionId ? { phase: "idle" } : a)); }, [baseRevisionId]);

  const send = async (prompt: string, key: string) => {
    setAsk({ phase: "asking", key, prompt });
    try {
      const proposal = await client.createAiProposal({ projectId, baseRevisionId, prompt, locale }, key);
      saw(undefined);
      if (live.current) setAsk({ phase: "done", proposal });
    } catch (e) {
      saw(e);
      const code = e instanceof ApiError ? (e.kind === "offline" ? "offline" : e.code ?? e.kind) : "UNEXPECTED";
      if (live.current) setAsk({ phase: "failed", key, prompt, code });
    }
    void loadQuota();
  };

  const submit = () => {
    const prompt = text.trim();
    if (!prompt || disabled) return;
    // Same text after a failure reuses the key: the API released the reservation, nothing is charged twice.
    void send(prompt, ask.phase === "failed" && ask.prompt === prompt ? ask.key : newId());
  };

  const errorText = (code: string) => {
    switch (code) {
      case "offline": return t("auraOffline");
      case "QUOTA_EXCEEDED": return t("auraQuota");
      case "AI_PROVIDER_UNAVAILABLE": case "AI_TIMEOUT": return t("auraDown");
      case "VERSION_CONFLICT": return t("auraStale");
      default: return t("auraFailed", { code });
    }
  };

  const change = (ch: AiProposalOption["changes"][number]) => ch.name === "materialId"
    ? <ChangeLine key={ch.name} label={t("material")} from={alloyName(String(ch.from), locale)} to={alloyName(String(ch.to), locale)} />
    : <ChangeLine key={ch.name} label={paramLabel(familyId, ch.name, locale)} from={mm(Number(ch.from), locale)} to={mm(Number(ch.to), locale)} />;

  const proposal = ask.phase === "done" ? ask.proposal : null;
  return (
    <View style={au.card} accessibilityLabel={t("auraTitle")}>
      <View style={au.head}>
        <View style={au.gem} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
        <Text accessibilityRole="header" style={au.h}>{t("auraTitle")}</Text>
      </View>
      <Text style={styles.muted}>{t("auraIntro")}</Text>
      <Text style={au.badge}>{t("auraSimulated")}</Text>
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder={t("auraPlaceholder")}
        placeholderTextColor={c.textMuted}
        accessibilityLabel={t("auraInput")}
        accessibilityHint={t("auraPlaceholder")}
        editable={ask.phase !== "asking"}
        multiline
        maxLength={2000}
        style={au.input}
      />
      {disabled && <Text accessibilityRole="alert" style={styles.muted}>{t(disabled === "offline" ? "auraOffline" : "auraPending")}</Text>}
      <Button label={ask.phase === "asking" ? t("auraAsking") : t("auraAsk")} disabled={!!disabled || ask.phase === "asking" || !text.trim()} onPress={submit} />
      {quota && <Text style={styles.muted}>{t("auraQuotaLine", { left: String(quota.remainingUnits), limit: String(quota.limitUnits) })}</Text>}
      {ask.phase === "asking" && <Loading label={t("auraAsking")} />}
      {ask.phase === "failed" && (
        <View style={{ gap: s[2] }}>
          <Text accessibilityRole="alert" style={[styles.body, { color: c.danger }]}>{errorText(ask.code)}</Text>
          {ask.code !== "QUOTA_EXCEEDED" && ask.code !== "VERSION_CONFLICT" && <Button variant="secondary" label={t("retry")} onPress={() => void send(ask.prompt, ask.key)} />}
        </View>
      )}
      {proposal && (
        <View style={{ gap: s[2] }} accessibilityLiveRegion="polite">
          {proposal.understood.length > 0 && <Text style={styles.muted}>{t("auraUnderstood", { what: proposal.understood.join(", ") })}</Text>}
          {proposal.notes.map((n, i) => (
            <Text key={i} accessibilityRole={n.code === "ASSUMPTION" ? "text" : "alert"}
              style={[styles.body, { color: n.code === "ASSUMPTION" || n.code === "ALREADY_SO" ? c.textMuted : c.warning }]}>{n.message}</Text>
          ))}
          {proposal.options.length === 0 && <Text style={styles.body}>{t("auraNoOptions")}</Text>}
          {proposal.options.map((o) => (
            <View key={o.index} style={[au.option, previewing === o.index && { borderColor: c.accent }]}>
              <Text accessibilityRole="header" style={au.optTitle}>{t("auraOption", { n: String(o.index + 1), title: o.title })}</Text>
              {o.changes.map(change)}
              {o.assumptions.map((a, i) => <Text key={i} style={styles.muted}>{a}</Text>)}
              <Button variant={previewing === o.index ? "primary" : "secondary"} selected={previewing === o.index}
                label={previewing === o.index ? t("auraPreviewing") : t("preview")} disabled={!!disabled || previewing !== null}
                hint={t("auraPreviewHint")} onPress={() => onPreview(proposal, o)} />
            </View>
          ))}
          {proposal.options.length > 0 && <Text style={styles.muted}>{t("auraNothingChanges")}</Text>}
        </View>
      )}
    </View>
  );
}

const au = StyleSheet.create({
  card: { backgroundColor: c.surface, borderRadius: 12, padding: s[4], gap: s[3], borderWidth: 1, borderColor: "rgba(197,160,89,0.55)" },
  head: { flexDirection: "row", alignItems: "center", gap: s[2] },
  gem: { width: 14, height: 14, backgroundColor: c.accent, transform: [{ rotate: "45deg" }], borderRadius: 2 },
  h: { color: c.text, fontSize: type[4], fontFamily: fonts.display },
  badge: { color: c.textMuted, fontSize: type[0], borderWidth: 1, borderColor: c.inputBorder, borderRadius: tokens.radius[0], paddingHorizontal: s[2], paddingVertical: s[1], alignSelf: "flex-start" },
  input: {
    minHeight: tokens.touchTargetDp * 1.5, borderWidth: 1, borderColor: c.inputBorder, borderRadius: tokens.radius[0],
    color: c.text, paddingHorizontal: s[3], paddingVertical: s[2], fontSize: type[2], textAlignVertical: "top",
  },
  option: { borderWidth: StyleSheet.hairlineWidth, borderColor: c.inputBorder, borderRadius: 10, padding: s[3], gap: s[2], backgroundColor: c.background },
  optTitle: { color: c.text, fontSize: type[3], fontFamily: fonts.display },
});
