// First-run welcome: shown once per phone, after the cover. It says what AUREA is in one look (a
// piece from the boutique, a jewel designed in 3D, a quote an advisor confirms) and gets out of the
// way: every action ends it, the main one sits in the thumb zone, and Android back means "explore".
import tokens from "@aurea/tokens";
import { useEffect } from "react";
import { BackHandler, Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CATALOG_ART } from "../catalogArt.generated";
import type { Key } from "../i18n";
import { useSession } from "../session";
import { Button, c, fonts, LINING, s, type } from "../ui";

const POINTS: { icon: number; text: Key }[] = [
  { icon: require("../../assets/icons/tab-boutique.png"), text: "welcomeBoutique" },
  { icon: require("../../assets/icons/tab-design.png"), text: "welcomeDesign" },
  { icon: require("../../assets/icons/tab-quote.png"), text: "welcomeQuote" },
];
/** The studio render fades into the page instead of ending on a hard edge. */
const FADE_STEPS = 8;

export type WelcomeChoice = "explore" | "create" | "signIn";

export function WelcomeScreen({ onChoose }: { onChoose: (choice: WelcomeChoice) => void }) {
  const { t, status } = useSession();
  const insets = useSafeAreaInsets();

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => { onChoose("explore"); return true; });
    return () => sub.remove();
  }, [onChoose]);

  return (
    <View style={[StyleSheet.absoluteFill, w.root]}>
      {/* One scroll for everything: on a tall phone the actions sit at the bottom (thumb zone); on a
          short one the page scrolls and nothing hides behind them. */}
      <ScrollView contentContainerStyle={w.scroll} bounces={false}>
        <View accessible accessibilityRole="image" accessibilityLabel={t("welcomeArtLabel")} style={w.hero}>
          <Image source={CATALOG_ART["AUR-RNG-001"]} style={w.heroImage} resizeMode="cover" />
          <View style={w.fade} pointerEvents="none">
            {Array.from({ length: FADE_STEPS }, (_, i) => (
              <View key={i} style={{ flex: 1, backgroundColor: c.background, opacity: (i + 1) / FADE_STEPS }} />
            ))}
          </View>
        </View>
        <View style={[w.copy, { paddingLeft: s[4] + insets.left, paddingRight: s[4] + insets.right }]}>
          <Text accessibilityRole="header" style={w.title}>{t("welcomeTitle")}</Text>
          <Text style={w.body}>{t("welcomeBody")}</Text>
          <View style={w.points}>
            {POINTS.map((p) => (
              <View key={p.text} style={w.point}>
                <Image source={p.icon} style={w.pointIcon} importantForAccessibility="no" accessibilityIgnoresInvertColors />
                <Text style={w.pointText}>{t(p.text)}</Text>
              </View>
            ))}
          </View>
        </View>
        <View style={[w.actions, { paddingBottom: insets.bottom + s[3], paddingLeft: s[4] + insets.left, paddingRight: s[4] + insets.right }]}>
          <Button label={t("welcomeExplore")} onPress={() => onChoose("explore")} />
          <Button label={t("welcomeCreate")} variant="secondary" onPress={() => onChoose("create")} />
          {status !== "signedIn" && (
            <Pressable accessibilityRole="button" accessibilityLabel={t("signIn")} onPress={() => onChoose("signIn")} style={w.link} hitSlop={8}>
              <Text style={w.linkText}>{t("signIn")}</Text>
            </Pressable>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const w = StyleSheet.create({
  root: { backgroundColor: c.background, zIndex: 5, elevation: 5 },
  scroll: { flexGrow: 1 },
  // Wider than tall, so title, points and actions fit under it on a phone without scrolling.
  hero: { width: "100%", aspectRatio: 1.5, overflow: "hidden" },
  heroImage: { width: "100%", height: "100%" },
  fade: { position: "absolute", left: 0, right: 0, bottom: 0, height: "28%" },
  copy: { paddingTop: s[3], gap: s[3] },
  title: { color: c.text, fontFamily: fonts.display, fontVariant: LINING, fontSize: type[6], lineHeight: type[6] * 1.1 },
  body: { color: c.textMuted, fontSize: type[2], lineHeight: type[2] * 1.5 },
  points: { marginTop: s[2], borderTopWidth: StyleSheet.hairlineWidth, borderColor: "rgba(197,160,89,0.22)" },
  point: {
    flexDirection: "row", alignItems: "center", gap: s[3], minHeight: tokens.touchTargetDp,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: "rgba(197,160,89,0.22)",
  },
  pointIcon: { width: 22, height: 22, tintColor: c.accent },
  pointText: { color: c.text, fontSize: type[2], flex: 1 },
  // marginTop auto pushes the actions to the bottom when the page is shorter than the screen.
  actions: { gap: s[2], paddingTop: s[5], marginTop: "auto" },
  link: { minHeight: tokens.touchTargetDp, alignItems: "center", justifyContent: "center" },
  linkText: { color: c.accent, fontSize: type[2] },
});
