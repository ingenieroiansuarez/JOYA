import tokens from "@aurea/tokens";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useReducer } from "react";
import { BackHandler, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { maybeCompleteAuthSession } from "expo-web-browser";
import { configFromBuild, ConfigError, type AppConfig } from "./config";
import { deviceLocale, translator } from "./i18n";
import { canGoBack, currentRoute, initialNav, navReducer, TABS, type Tab } from "./nav";
import { CatalogScreen } from "./screens/CatalogScreen";
import { FavoritesScreen } from "./screens/FavoritesScreen";
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
          <Shell />
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

const TAB_LABEL = { boutique: "tabBoutique", favorites: "tabFavorites", profile: "tabProfile" } as const;

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
      {config.env !== "production" && <Text style={styles.banner}>{t("envBanner", { env: config.env })}</Text>}
      <View style={{ flex: 1 }}>
        {route.name === "catalog" && <CatalogScreen onOpen={open} />}
        {route.name === "favorites" && <FavoritesScreen onOpen={open} onExplore={() => dispatch({ type: "tab", tab: "boutique" })} />}
        {route.name === "profile" && <ProfileScreen />}
        {route.name === "product" && <ProductScreen key={route.id} id={route.id} onBack={back} />}
      </View>
      <View accessibilityRole="tablist" style={[bar.root, { paddingBottom: insets.bottom + s[1] }]}>
        {TABS.map((tab: Tab) => {
          const selected = nav.tab === tab;
          return (
            <Pressable key={tab} accessibilityRole="tab" accessibilityState={{ selected }} accessibilityLabel={t(TAB_LABEL[tab])}
              onPress={() => dispatch({ type: "tab", tab })} style={bar.tab}>
              <View style={[bar.mark, selected && { backgroundColor: c.accent }]} />
              <Text style={[bar.label, selected && { color: c.accent, fontWeight: "600" }]}>{t(TAB_LABEL[tab])}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const bar = StyleSheet.create({
  root: { flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth, borderColor: c.inputBorder, backgroundColor: c.surface, paddingBottom: s[1] },
  tab: { flex: 1, minHeight: tokens.touchTargetDp + s[2], alignItems: "center", justifyContent: "center", gap: s[0] },
  mark: { width: 24, height: 3, borderRadius: 2, backgroundColor: "transparent" },
  label: { color: c.textMuted, fontSize: type[1] },
});
