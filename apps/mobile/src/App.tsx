import tokens from "@aurea/tokens";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useReducer } from "react";
import { BackHandler, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { maybeCompleteAuthSession } from "expo-web-browser";
import { configFromBuild, ConfigError, type AppConfig } from "./config";
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
import { SessionProvider, useSession } from "./session";
import { c, s, styles, type } from "./ui";

maybeCompleteAuthSession();

export default function App() {
  const config = useMemo<AppConfig | ConfigError>(() => {
    try {
      return configFromBuild();
    } catch (e) {
      return e instanceof ConfigError ? e : new ConfigError("invalid configuration");
    }
  }, []);
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
// Tab marks drawn with text glyphs (no icon font to license or bundle): outline when idle, filled when selected.
const TAB_GLYPH = { boutique: ["◇", "◆"], design: ["✧", "✦"], favorites: ["♡", "♥"], profile: ["○", "●"] } as const;

function Shell() {
  const { t, config } = useSession();
  const [nav, dispatch] = useReducer(navReducer, initialNav);
  const route = currentRoute(nav);
  const insets = useSafeAreaInsets();

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
      <View style={{ flex: 1 }}>
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
      <View accessibilityRole="tablist" style={[bar.root, { paddingBottom: insets.bottom + s[1] }]}>
        {TABS.map((tab: Tab) => {
          const selected = nav.tab === tab;
          return (
            <Pressable key={tab} accessibilityRole="tab" accessibilityState={{ selected }} accessibilityLabel={t(TAB_LABEL[tab])}
              onPress={() => dispatch({ type: "tab", tab })} style={bar.tab}>
              <View style={[bar.mark, selected && { backgroundColor: c.accent }]} />
              <Text style={[bar.glyph, selected && { color: c.accent }]} importantForAccessibility="no">{TAB_GLYPH[tab][selected ? 1 : 0]}</Text>
              <Text style={[bar.label, selected && { color: c.accent, fontWeight: "600" }]}>{t(TAB_LABEL[tab])}</Text>
            </Pressable>
          );
        })}
      </View>
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
  glyph: { color: c.textMuted, fontSize: type[3], lineHeight: type[3] * 1.15 },
  label: { color: c.textMuted, fontSize: type[0], letterSpacing: 1, textTransform: "uppercase" },
});
