import tokens from "@aurea/tokens";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { BackHandler, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { maybeCompleteAuthSession } from "expo-web-browser";
import { configFromBuild, ConfigError, type AppConfig } from "./config";
import { Cover, holdNativeSplash } from "./Cover";
import { deviceLocale, translator } from "./i18n";
import { canGoBack, currentRoute, initialNav, navReducer, TABS, type Tab } from "./nav";
import { DesignProvider } from "./design/DesignContext";
import { CatalogScreen } from "./screens/CatalogScreen";
import { DesignsScreen } from "./screens/DesignsScreen";
import { EditorScreen } from "./screens/EditorScreen";
import { FavoritesScreen } from "./screens/FavoritesScreen";
import { NewDesignScreen } from "./screens/NewDesignScreen";
import { OrderScreen } from "./screens/OrderScreen";
import { QuoteScreen } from "./screens/QuoteScreen";
import { ProductScreen } from "./screens/ProductScreen";
import { ProfileScreen } from "./screens/ProfileScreen";
import { WelcomeScreen, type WelcomeChoice } from "./screens/WelcomeScreen";
import { markWelcomed, shouldWelcome } from "./firstRun";
import { SessionProvider, useSession } from "./session";
import { c, s, styles, type } from "./ui";

maybeCompleteAuthSession();
holdNativeSplash();

export default function App() {
  const config = useMemo<AppConfig | ConfigError>(() => {
    try {
      return configFromBuild();
    } catch (e) {
      return e instanceof ConfigError ? e : new ConfigError("invalid configuration");
    }
  }, []);
  const [covered, setCovered] = useState(true);
  return (
    // Android draws edge to edge: every screen keeps clear of the status bar and the system navigation
    // (3-button or gesture bar) through the insets, never fixed paddings.
    <SafeAreaProvider>
      {config instanceof ConfigError ? (
        <ConfigErrorScreen />
      ) : (
        <SessionProvider config={config}>
          <DesignProvider>
            <Shell />
          </DesignProvider>
        </SessionProvider>
      )}
      {/* Over the app, not instead of it: the session restores and the first screen loads underneath. */}
      {covered && <Cover tagline={translator(deviceLocale())("coverTagline")} onDone={() => setCovered(false)} />}
    </SafeAreaProvider>
  );
}

function ConfigErrorScreen() {
  const t = translator(deviceLocale());
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.screen, styles.center, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <StatusBar style="light" />
      <Text accessibilityRole="alert" style={[styles.body, { color: c.danger }]}>{t("configError")}</Text>
    </View>
  );
}

const TAB_LABEL = { boutique: "tabBoutique", design: "tabDesign", favorites: "tabFavorites", profile: "tabProfile" } as const;
// Tab icons drawn in-house (tools/icons/render.mjs: line art, white, 1×–3×), tinted muted or gold.
const TAB_ICON: Record<Tab, number> = {
  boutique: require("../assets/icons/tab-boutique.png"),
  design: require("../assets/icons/tab-design.png"),
  favorites: require("../assets/icons/tab-favorites.png"),
  profile: require("../assets/icons/tab-profile.png"),
};

function Shell() {
  const { t, config, signIn } = useSession();
  const [nav, dispatch] = useReducer(navReducer, initialNav);
  const route = currentRoute(nav);
  const insets = useSafeAreaInsets();
  // First run only: decided once at launch, under the cover, so the welcome never flashes in late.
  const [welcome, setWelcome] = useState(false);
  useEffect(() => { let live = true; shouldWelcome().then((show) => { if (live) setWelcome(show); }); return () => { live = false; }; }, []);
  const chooseWelcome = useCallback((choice: WelcomeChoice) => {
    setWelcome(false);
    void markWelcomed();
    if (choice === "create") dispatch({ type: "tab", tab: "design" });
    if (choice === "signIn") void signIn();
  }, [signIn]);

  // Android back: pop inside the app while there is somewhere to go; otherwise let the system close it.
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!canGoBack(nav)) return false;
      dispatch({ type: "back" });
      return true;
    });
    return () => sub.remove();
  }, [nav]);

  const open = (id: string) => dispatch({ type: "push", route: { name: "product", id } });
  const back = () => dispatch({ type: "back" });

  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }]}>
      <StatusBar style="light" />
      {config.env !== "production" && <Text style={[styles.banner, shell.banner]}>{t("envBanner", { env: config.env })}</Text>}
      {/* While the welcome covers the app, screen readers must not find the boutique behind it. */}
      <View style={{ flex: 1 }} importantForAccessibility={welcome ? "no-hide-descendants" : "auto"} accessibilityElementsHidden={welcome}>
        {route.name === "catalog" && <CatalogScreen onOpen={open} />}
        {route.name === "favorites" && <FavoritesScreen onOpen={open} onExplore={() => dispatch({ type: "tab", tab: "boutique" })} />}
        {route.name === "profile" && <ProfileScreen />}
        {route.name === "product" && <ProductScreen key={route.id} id={route.id} onBack={back} />}
        {route.name === "designs" && (
          <DesignsScreen onOpen={(id) => dispatch({ type: "push", route: { name: "editor", id } })}
            onNew={() => dispatch({ type: "push", route: { name: "newDesign" } })} />
        )}
        {route.name === "newDesign" && (
          <NewDesignScreen onBack={back} onCreated={(id) => dispatch({ type: "replace", route: { name: "editor", id } })} />
        )}
        {route.name === "editor" && (
          <EditorScreen key={route.id} id={route.id} onBack={back}
            onQuote={(revisionId) => dispatch({ type: "push", route: { name: "quote", revisionId } })} />
        )}
        {route.name === "quote" && (
          <QuoteScreen key={route.revisionId} revisionId={route.revisionId} onBack={back}
            onOrder={(id) => dispatch({ type: "replace", route: { name: "order", id } })} />
        )}
        {route.name === "order" && <OrderScreen key={route.id} id={route.id} onBack={back} />}
      </View>
      <View accessibilityRole="tablist" importantForAccessibility={welcome ? "no-hide-descendants" : "auto"} accessibilityElementsHidden={welcome}
        style={[bar.root, { paddingBottom: insets.bottom + s[1] }]}>
        {TABS.map((tab: Tab) => {
          const selected = nav.tab === tab;
          return (
            <Pressable key={tab} accessibilityRole="tab" accessibilityState={{ selected }} accessibilityLabel={t(TAB_LABEL[tab])}
              onPress={() => dispatch({ type: "tab", tab })} style={bar.tab}>
              <View style={[bar.mark, selected && { backgroundColor: c.accent }]} />
              <Image source={TAB_ICON[tab]} style={[bar.icon, { tintColor: selected ? c.accent : c.textMuted }]} importantForAccessibility="no" accessibilityIgnoresInvertColors />
              <Text style={[bar.label, selected && { color: c.accent, fontWeight: "600" }]}>{t(TAB_LABEL[tab])}</Text>
            </Pressable>
          );
        })}
      </View>
      {welcome && <WelcomeScreen onChoose={chooseWelcome} />}
    </View>
  );
}

const shell = StyleSheet.create({
  banner: { textAlign: "center", fontSize: type[0], letterSpacing: 1, textTransform: "uppercase" },
});

const bar = StyleSheet.create({
  root: { flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth, borderColor: c.inputBorder, backgroundColor: c.surface, paddingBottom: s[1] },
  tab: { flex: 1, minHeight: tokens.touchTargetDp + s[2], alignItems: "center", justifyContent: "center", gap: s[0] },
  mark: { position: "absolute", top: 0, width: 28, height: 2, borderRadius: 1, backgroundColor: "transparent" },
  icon: { width: 24, height: 24 },
  label: { color: c.textMuted, fontSize: type[0], letterSpacing: 1, textTransform: "uppercase" },
});
