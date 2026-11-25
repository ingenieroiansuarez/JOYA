import tokens from "@aurea/tokens";
import { FAMILIES, MATERIALS } from "@aurea/design";
import { useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ApiError } from "../api";
import { useDesign } from "../design/DesignContext";
import { alloyColor } from "../design/describe";
import { useSession } from "../session";
import { Button, c, Header, s, styles, type } from "../ui";

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
        <View accessibilityRole="radiogroup" style={form.group}>
          {FAMILIES.map((f) => {
            const selected = f.id === familyId;
            return (
              <Pressable key={f.id} accessibilityRole="radio" accessibilityState={{ selected }} accessibilityLabel={f.name[locale]}
                onPress={() => setFamily(f.id)} style={[form.option, selected && form.selected]}>
                <Text style={[styles.body, selected && { color: c.accent }]}>{f.name[locale]}</Text>
                <Text style={styles.muted}>{f.category === "ring" ? t("category_RING") : t("category_PENDANT")}</Text>
              </Pressable>
            );
          })}
        </View>
        <Text accessibilityRole="header" style={form.label}>{t("alloy")}</Text>
        <View accessibilityRole="radiogroup" style={form.chips}>
          {MATERIALS.map((m) => {
            const selected = m.id === materialId;
            return (
              <Pressable key={m.id} accessibilityRole="radio" accessibilityState={{ selected }} accessibilityLabel={m.name[locale]}
                onPress={() => setMaterial(m.id)} style={[form.chip, selected && form.selected]}>
                <View style={[form.swatch, { backgroundColor: alloyColor(m.id) }]} />
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
  label: { color: c.textMuted, fontSize: type[1], fontWeight: "600" },
  input: {
    minHeight: tokens.touchTargetDp, borderWidth: 1, borderColor: c.inputBorder, borderRadius: tokens.radius[0], color: c.text,
    paddingHorizontal: s[3], fontSize: type[2],
  },
  group: { gap: s[2] },
  option: { minHeight: tokens.touchTargetDp, borderRadius: tokens.radius[0], borderWidth: 1, borderColor: c.inputBorder, padding: s[3], gap: 2 },
  selected: { borderColor: c.accent },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: s[2] },
  chip: {
    minHeight: tokens.touchTargetDp, flexDirection: "row", alignItems: "center", gap: s[1], paddingHorizontal: s[3],
    borderRadius: tokens.radius[0], borderWidth: 1, borderColor: c.inputBorder,
  },
  swatch: { width: 14, height: 14, borderRadius: 7 },
});
