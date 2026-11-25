import tokens from "@aurea/tokens";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import type { DiscoveryDocument } from "expo-auth-session";
import { maybeCompleteAuthSession } from "expo-web-browser";
import { discover, fetchMe, signIn, signOut, type Me } from "./auth";
import { configFromBuild, ConfigError, type AppConfig } from "./config";
import { deviceLocale, translator } from "./i18n";

maybeCompleteAuthSession();

const c = tokens.themes.dark;
const s = tokens.space;

type State =
  | { kind: "signedOut" }
  | { kind: "busy" }
  | { kind: "failed" }
  | { kind: "signedIn"; me: Me };

export default function App() {
  const t = useMemo(() => translator(deviceLocale()), []);
  const config = useMemo<AppConfig | ConfigError>(() => {
    try {
      return configFromBuild();
    } catch (e) {
      return e instanceof ConfigError ? e : new ConfigError("invalid configuration");
    }
  }, []);
  const [discovery, setDiscovery] = useState<DiscoveryDocument | null>(null);
  const [state, setState] = useState<State>({ kind: "signedOut" });

  useEffect(() => {
    if (config instanceof ConfigError) return;
    discover(config).then(setDiscovery, () => setState({ kind: "failed" }));
  }, [config]);

  if (config instanceof ConfigError) {
    return (
      <Screen>
        <Text accessibilityRole="alert" style={[styles.body, { color: c.danger }]}>{t("configError")}</Text>
      </Screen>
    );
  }

  const login = async () => {
    if (!discovery) return;
    setState({ kind: "busy" });
    try {
      const session = await signIn(discovery);
      setState(session ? { kind: "signedIn", me: await fetchMe(config, session) } : { kind: "signedOut" });
    } catch {
      setState({ kind: "failed" });
    }
  };

  return (
    <Screen banner={config.env !== "production" ? t("envBanner", { env: config.env }) : undefined}>
      <Text accessibilityRole="header" style={styles.title}>{t("welcome")}</Text>
      {state.kind === "busy" && (
        <View accessibilityLiveRegion="polite" style={styles.row}>
          <ActivityIndicator color={c.accent} />
          <Text style={styles.body}>{t("signingIn")}</Text>
        </View>
      )}
      {state.kind === "failed" && <Text accessibilityRole="alert" style={[styles.body, { color: c.danger }]}>{t("signInFailed")}</Text>}
      {state.kind === "signedIn" ? (
        <>
          <Text style={styles.body}>{t("signedInAs")}</Text>
          <Text style={styles.muted}>{t("roles", { roles: state.me.roles.join(", ") })}</Text>
          <Button label={t("signOut")} onPress={async () => { if (discovery) await signOut(discovery); setState({ kind: "signedOut" }); }} />
        </>
      ) : (
        <Button
          label={state.kind === "failed" ? t("retry") : t("signIn")}
          disabled={!discovery || state.kind === "busy"}
          onPress={login}
        />
      )}
    </Screen>
  );
}

function Screen({ children, banner }: { children: React.ReactNode; banner?: string }) {
  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      {banner && <Text accessibilityRole="text" style={styles.banner}>{banner}</Text>}
      <View style={styles.content}>{children}</View>
    </View>
  );
}

function Button({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.button, (disabled || pressed) && { opacity: 0.6 }]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.background },
  banner: { backgroundColor: c.surface, color: c.warning, paddingHorizontal: s[3], paddingVertical: s[1], paddingTop: s[6] },
  content: { flex: 1, padding: s[4], gap: s[3], justifyContent: "center" },
  title: { color: c.text, fontSize: tokens.typography.scale[5], fontWeight: "600" },
  body: { color: c.text, fontSize: tokens.typography.scale[2] },
  muted: { color: c.textMuted, fontSize: tokens.typography.scale[2] },
  row: { flexDirection: "row", gap: s[1], alignItems: "center" },
  button: { minHeight: tokens.touchTargetDp, borderRadius: tokens.radius[0], backgroundColor: c.accent, alignItems: "center", justifyContent: "center", paddingHorizontal: s[4] },
  buttonText: { color: c.onAccent, fontSize: tokens.typography.scale[2], fontWeight: "600" },
});
