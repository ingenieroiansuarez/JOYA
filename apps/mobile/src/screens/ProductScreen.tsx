import tokens from "@aurea/tokens";
import { useCallback, useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { ApiError, type Product } from "../api";
import { formatDecimal, formatMoney } from "../format";
import { useSession } from "../session";
import { Button, c, errorKey, Header, JewelIllustration, Loading, Notice, s, styles, type } from "../ui";

type State = { phase: "loading" } | { phase: "error"; error: ApiError } | { phase: "ready"; product: Product };

export function ProductScreen({ id, onBack }: { id: string; onBack: () => void }) {
  const { t, locale, api, favorites, toggleFavorite, signIn, status } = useSession();
  const [state, setState] = useState<State>({ phase: "loading" });
  const [favNotice, setFavNotice] = useState<"signIn" | "failed" | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    try {
      setState({ phase: "ready", product: await api.getProduct(id) });
    } catch (e) {
      setState({ phase: "error", error: e instanceof ApiError ? e : new ApiError("unexpected") });
    }
  }, [api, id]);
  useEffect(() => { void load(); }, [load]);
  // Signing in from the prompt below answers it.
  useEffect(() => { if (status === "signedIn" && favNotice === "signIn") setFavNotice(null); }, [status, favNotice]);

  const header = <Header title="" onBack={onBack} backLabel={t("back")} />;
  if (state.phase === "loading") return <View style={styles.screen}>{header}<Loading label={t("loadingProduct")} /></View>;
  if (state.phase === "error") {
    return (
      <View style={styles.screen}>
        {header}
        {state.error.kind === "notFound" || state.error.kind === "invalid"
          ? <Notice alert message={t("productNotFound")} action={{ label: t("backToCatalog"), onPress: onBack }} />
          : <Notice alert message={t(errorKey(state.error))} action={{ label: t("retry"), onPress: load }} />}
      </View>
    );
  }

  const p = state.product;
  const saved = favorites.has(p.id);
  const onFavorite = async () => {
    setBusy(true);
    const result = await toggleFavorite(p.id);
    setBusy(false);
    setFavNotice(result === "needsSignIn" ? "signIn" : result === "failed" ? "failed" : null);
  };
  const specs: [string, string][] = [
    [t("specMetal"), t(`metal_${p.metal}`)],
    [t("specWeight"), formatDecimal(p.metalWeightGrams, "g", locale)],
    [t("specStones"), p.stones.length === 0 ? t("noStones") : p.stones.map((st) => t("stoneLine", {
      count: String(st.count), stone: t(`stone_${st.type}`), origin: t(`origin_${st.origin}`), carats: formatDecimal(st.totalCarats, "ct", locale),
    })).join("\n")],
    ...(p.collection ? [[t("specCollection"), p.collection] as [string, string]] : []),
    [t("specSku"), p.sku],
  ];

  return (
    <View style={styles.screen}>
      {header}
      <ScrollView contentContainerStyle={detail.content}>
        <JewelIllustration metal={p.metal} stone={p.stones[0]?.type} size={280} label={t("illustration", { name: p.name })} />
        <Text accessibilityRole="header" style={styles.title}>{p.name}</Text>
        <Text style={detail.price}>{formatMoney(p.price.amount, p.price.currency, locale)}</Text>
        <View style={detail.badges}>
          <Text style={[detail.badge, { color: p.available ? c.success : c.warning }]}>{p.available ? t("available") : t("soldOut")}</Text>
          {p.customizable && <Text style={[detail.badge, { color: c.info }]}>{t("customizable")}</Text>}
        </View>
        <Text style={styles.body}>{p.summary}</Text>
        <Button
          label={saved ? t("removeFavorite") : t("saveFavorite")}
          variant={saved ? "secondary" : "primary"}
          selected={saved}
          disabled={busy}
          onPress={onFavorite}
        />
        {favNotice === "signIn" && (
          <View style={detail.prompt}>
            <Text accessibilityRole="alert" style={styles.body}>{t("signInToSave")}</Text>
            <Button label={t("signIn")} onPress={signIn} disabled={status === "signingIn"} />
          </View>
        )}
        {favNotice === "failed" && <Text accessibilityRole="alert" style={[styles.body, { color: c.danger }]}>{t("favoriteFailed")}</Text>}
        <View style={detail.specs}>
          {specs.map(([k, v]) => (
            <View key={k} style={detail.specRow} accessible accessibilityLabel={`${k}: ${v}`}>
              <Text style={detail.specKey}>{k}</Text>
              <Text style={detail.specValue}>{v}</Text>
            </View>
          ))}
        </View>
        <Text style={styles.muted}>{p.description}</Text>
      </ScrollView>
    </View>
  );
}

const detail = StyleSheet.create({
  content: { padding: s[4], gap: s[3], paddingBottom: s[6] },
  price: { color: c.accent, fontSize: type[3], fontWeight: "600" },
  badges: { flexDirection: "row", gap: s[3] },
  badge: { fontSize: type[1], fontWeight: "600" },
  prompt: { gap: s[2], padding: s[3], borderRadius: tokens.radius[0], backgroundColor: c.surface },
  specs: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: c.inputBorder },
  specRow: { paddingVertical: s[2], borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.inputBorder, gap: 2 },
  specKey: { color: c.textMuted, fontSize: type[1] },
  specValue: { color: c.text, fontSize: type[2] },
});
