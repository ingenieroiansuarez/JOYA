import tokens from "@aurea/tokens";
import { useCallback, useEffect, useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ApiError, type Product } from "../api";
import { formatDecimal, formatMoney } from "../format";
import { useSession } from "../session";
import { Button, c, errorKey, fonts, LINING, hasCatalogArt, Header, JewelArt, Loading, Notice, s, styles, type } from "../ui";

type State = { phase: "loading" } | { phase: "error"; error: ApiError } | { phase: "ready"; product: Product };

export function ProductScreen({ id, onBack }: { id: string; onBack: () => void }) {
  const { t, locale, api, favorites, setFavorite, ensureFavorites, signIn, status } = useSession();
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
  useEffect(() => { if (status === "signedIn") void ensureFavorites(); }, [status, ensureFavorites]);
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
    const result = await setFavorite(p.id, !saved);
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
      <ScrollView contentContainerStyle={detail.scroll}>
        <JewelArt sku={p.sku} metal={p.metal} stone={p.stones[0]?.type} label={t(hasCatalogArt(p.sku) ? "illustration3d" : "illustration", { name: p.name })} />
        <View style={detail.content}>
        <Text style={styles.overline}>{[p.collection, t(`metal_${p.metal}`)].filter(Boolean).join(" · ")}</Text>
        <Text accessibilityRole="header" style={detail.name}>{p.name}</Text>
        <Text style={detail.price}>{formatMoney(p.price.amount, p.price.currency, locale)}</Text>
        <View style={detail.badges}>
          <Text style={[detail.badge, { color: p.available ? c.success : c.warning }]}>{p.available ? t("available") : t("soldOut")}</Text>
          {p.customizable && <Text style={[detail.badge, { color: c.info }]}>{t("customizable")}</Text>}
        </View>
        <Text style={styles.body}>{p.summary}</Text>
        <View style={detail.specs}>
          {specs.map(([k, v]) => (
            <View key={k} style={detail.specRow} accessible accessibilityLabel={`${k}: ${v}`}>
              <Text style={detail.specKey}>{k}</Text>
              <Text style={detail.specValue}>{v}</Text>
            </View>
          ))}
        </View>
        <Text style={styles.muted}>{p.description}</Text>
        {hasCatalogArt(p.sku) && <Text style={styles.muted}>{t("illustration3dNote")}</Text>}
        </View>
      </ScrollView>
      {/* The page's one action stays in the thumb zone while the details scroll above it. */}
      <View style={[detail.actionBar, { paddingBottom: s[2] }]}>
          {favNotice === "signIn" && (
            <View style={detail.prompt}>
              <Text accessibilityRole="alert" style={styles.body}>{t("signInToSave")}</Text>
              <Button label={t("signIn")} onPress={signIn} disabled={status === "signingIn"} />
            </View>
          )}
          {favNotice === "failed" && <Text accessibilityRole="alert" style={[styles.body, { color: c.danger }]}>{t("favoriteFailed")}</Text>}
        <Pressable accessibilityRole="button" accessibilityLabel={saved ? t("removeFavorite") : t("saveFavorite")}
          accessibilityState={{ selected: saved, disabled: busy }} disabled={busy} onPress={onFavorite}
          style={({ pressed }) => [detail.favButton, saved ? detail.favSaved : detail.favIdle, (busy || pressed) && { opacity: 0.6 }]}>
          <Image source={saved ? HEART_FILLED : HEART} style={[detail.favIcon, { tintColor: saved ? c.accent : c.onAccent }]}
            importantForAccessibility="no" accessibilityIgnoresInvertColors />
          <Text style={[detail.favText, { color: saved ? c.accent : c.onAccent }]}>{saved ? t("removeFavorite") : t("saveFavorite")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const HEART: number = require("../../assets/icons/tab-favorites.png");
const HEART_FILLED: number = require("../../assets/icons/tab-favorites-filled.png");

const detail = StyleSheet.create({
  actionBar: {
    paddingHorizontal: s[4], paddingTop: s[2], gap: s[2], backgroundColor: c.background,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "rgba(197,160,89,0.22)",
  },
  favButton: {
    minHeight: tokens.touchTargetDp, borderRadius: tokens.radius[0], flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: s[2], paddingHorizontal: s[4],
  },
  favIdle: { backgroundColor: c.accent },
  favSaved: { borderWidth: 1, borderColor: c.accent },
  favIcon: { width: 20, height: 20 },
  favText: { fontSize: type[2], fontWeight: "600" },
  scroll: { paddingBottom: s[6] },
  content: { padding: s[4], gap: s[3] },
  name: { color: c.text, fontSize: type[6], fontFamily: fonts.display, fontVariant: LINING, lineHeight: type[6] * 1.1 },
  price: { color: c.accent, fontSize: type[4], fontFamily: fonts.displayStrong, fontVariant: ["lining-nums"], letterSpacing: 0.3 },
  badges: { flexDirection: "row", gap: s[3] },
  badge: { fontSize: type[1], fontWeight: "600" },
  prompt: { gap: s[2], padding: s[3], borderRadius: tokens.radius[0], backgroundColor: c.surface },
  specs: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: c.inputBorder },
  specRow: { paddingVertical: s[2], borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.inputBorder, gap: 2 },
  specKey: { color: c.textMuted, fontSize: type[0], letterSpacing: 1.2, textTransform: "uppercase" },
  specValue: { color: c.text, fontSize: type[2] },
});
