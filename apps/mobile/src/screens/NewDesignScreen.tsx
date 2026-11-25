import tokens from "@aurea/tokens";
import { FAMILIES, MATERIALS } from "@aurea/design";
import { useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ApiError } from "../api";
import { useDesign } from "../design/DesignContext";
import { AlloySwatch, FamilyArt } from "../design/art";
import { useSession } from "../session";
import { Button, c, fonts, LINING, Header, s, styles, type } from "../ui";

type Notice = null | "offline" | "failed" | "name";

export function NewDesignScreen({ onBack, onCreated }: { onBack: () => void; onCreated: (id: string) => void }) {
  const { t, locale } = useSession();
  const { client, store, saw, newId, bump } = useDesign();
  const [title, setTitle] = useState(t("designNameDefault"));
  const [familyId, setFamily] = useState(FAMILIES[0].id);
  const [materialId, setMaterial] = useState(MATERIALS[0].id);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  // One key per form: a retry after a lost answer returns the same project instead of a second one.
  const key = useRef(newId());
  const sent = useRef("");

  const create = async () => {
    const name = title.trim();
    if (name.length < 1 || name.length > 80) { setNotice("name"); return; }
    const body = { title: name, templateId: familyId, materialId };
    if (sent.current && sent.current !== JSON.stringify(body)) key.current = newId(); // a different request
    sent.current = JSON.stringify(body);
    setBusy(true);
    setNotice(null);
    try {
      const project = await client.createProject(body, key.current);
      const head = await client.getRevision(project.id, project.headRevisionId);
      await store?.putProject({ project, head });
      saw(undefined);
      bump();
      onCreated(project.id);
    } catch (e) {
      saw(e);
      setNotice(e instanceof ApiError && e.kind === "offline" ? "offline" : "failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.screen}>
      <Header title={t("newDesignTitle")} onBack={onBack} backLabel={t("back")} />
      <ScrollView contentContainerStyle={form.content} keyboardShouldPersistTaps="handled">
        <Text style={form.label} nativeID="design-name">{t("designName")}</Text>
        <TextInput value={title} onChangeText={setTitle} maxLength={80} accessibilityLabel={t("designName")} accessibilityLabelledBy="design-name"
          style={form.input} placeholderTextColor={c.textMuted} />
        <Text accessibilityRole="header" style={form.label}>{t("family")}</Text>
        <View accessibilityRole="radiogroup" style={form.grid}>
          {FAMILIES.map((f) => {
            const selected = f.id === familyId;
            const kind = f.category === "ring" ? t("category_RING") : t("category_PENDANT");
            return (
              <Pressable key={f.id} accessibilityRole="radio" accessibilityState={{ selected }} accessibilityLabel={`${f.name[locale]}, ${kind}`}
                onPress={() => setFamily(f.id)} style={[form.option, selected && form.selected]}>
                <FamilyArt familyId={f.id} materialId={materialId} label="" />
                <View style={form.optionText}>
                  <Text style={form.optionKind}>{kind}</Text>
                  <Text style={[form.optionName, selected && { color: c.accent }]}>{f.name[locale]}</Text>
                </View>
                {selected && <View style={form.check}><Text style={form.checkText}>✓</Text></View>}
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.muted}>{t("familyArtNote")}</Text>
        <Text accessibilityRole="header" style={form.label}>{t("alloy")}</Text>
        <View accessibilityRole="radiogroup" style={form.chips}>
          {MATERIALS.map((m) => {
            const selected = m.id === materialId;
            return (
              <Pressable key={m.id} accessibilityRole="radio" accessibilityState={{ selected }} accessibilityLabel={m.name[locale]}
                onPress={() => setMaterial(m.id)} style={[form.chip, selected && form.selected]}>
                <AlloySwatch id={m.id} />
                <Text style={[styles.muted, selected && { color: c.accent }]}>{m.name[locale]}</Text>
              </Pressable>
            );
          })}
        </View>
        {notice && (
          <Text accessibilityRole="alert" style={[styles.body, { color: notice === "offline" ? c.warning : c.danger }]}>
            {t(notice === "offline" ? "createNeedsConnection" : notice === "name" ? "nameRequired" : "createFailed")}
          </Text>
        )}
        <Button label={busy ? t("creating") : t("create")} onPress={create} disabled={busy} />
      </ScrollView>
    </View>
  );
}

const form = StyleSheet.create({
  content: { padding: s[4], gap: s[3], paddingBottom: s[6] },
  label: { color: c.accent, fontSize: type[0], fontWeight: "600", letterSpacing: 2, textTransform: "uppercase", marginTop: s[2] },
  input: {
    minHeight: tokens.touchTargetDp, borderWidth: 1, borderColor: c.inputBorder, borderRadius: tokens.radius[0], color: c.text,
    paddingHorizontal: s[3], fontSize: type[2],
  },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: s[2] },
  option: {
    width: "48%", flexGrow: 1, minHeight: tokens.touchTargetDp, borderRadius: tokens.radius[1], borderWidth: 1, borderColor: c.inputBorder,
    overflow: "hidden", backgroundColor: c.surface,
  },
  optionText: { padding: s[2], gap: 2 },
  optionKind: { color: c.textMuted, fontSize: type[0], letterSpacing: 1.2, textTransform: "uppercase" },
  optionName: { color: c.text, fontSize: type[3], fontFamily: fonts.display, fontVariant: LINING },
  check: {
    position: "absolute", top: s[2], right: s[2], width: 26, height: 26, borderRadius: 13, backgroundColor: c.accent,
    alignItems: "center", justifyContent: "center",
  },
  checkText: { color: c.onAccent, fontWeight: "700" },
  selected: { borderColor: c.accent },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: s[2] },
  chip: {
    minHeight: tokens.touchTargetDp, flexDirection: "row", alignItems: "center", gap: s[1], paddingLeft: s[1], paddingRight: s[3],
    borderRadius: tokens.touchTargetDp / 2, borderWidth: 1, borderColor: c.inputBorder, backgroundColor: c.surface,
  },
});
