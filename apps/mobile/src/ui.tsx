// Shared building blocks. Every control is at least tokens.touchTargetDp tall, carries an
// accessibility role and label, and status text is announced (live region or alert role).
import tokens from "@aurea/tokens";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import type { ApiError } from "./api";
import type { Key } from "./i18n";
import type { Metal } from "./api";

export const c = tokens.themes.dark;
export const s = tokens.space;
export const type = tokens.typography.scale;

export function Button({ label, onPress, disabled, variant = "primary", hint, selected }: {
  label: string; onPress: () => void; disabled?: boolean; variant?: "primary" | "secondary"; hint?: string; selected?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: !!disabled, ...(selected === undefined ? {} : { selected }) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.button, variant === "secondary" && styles.secondary, (disabled || pressed) && { opacity: 0.6 }]}
    >
      <Text style={[styles.buttonText, variant === "secondary" && { color: c.accent }]}>{label}</Text>
    </Pressable>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <View accessible accessibilityLiveRegion="polite" accessibilityLabel={label} style={styles.center}>
      <ActivityIndicator color={c.accent} size="large" />
      <Text style={styles.muted}>{label}</Text>
    </View>
  );
}

export function errorKey(err: ApiError | null): Key {
  if (err?.kind === "offline") return "errorOffline";
  if (err?.kind === "unavailable") return "errorUnavailable";
  return "errorUnexpected";
}

/** Error and empty states share one layout: a message and, when there is one, the way out. */
export function Notice({ message, action, alert }: { message: string; action?: { label: string; onPress: () => void }; alert?: boolean }) {
  return (
    <View style={styles.center}>
      <Text accessibilityRole={alert ? "alert" : "text"} accessibilityLiveRegion={alert ? "assertive" : "polite"} style={[styles.body, styles.centerText]}>
        {message}
      </Text>
      {action && <Button label={action.label} onPress={action.onPress} variant="secondary" />}
    </View>
  );
}

export function Header({ title, subtitle, onBack, backLabel }: { title: string; subtitle?: string; onBack?: () => void; backLabel?: string }) {
  return (
    <View style={styles.header}>
      {onBack && (
        <Pressable accessibilityRole="button" accessibilityLabel={backLabel} onPress={onBack} hitSlop={8} style={styles.back}>
          <Text style={styles.backText}>‹ {backLabel}</Text>
        </Pressable>
      )}
      <Text accessibilityRole="header" style={styles.title}>{title}</Text>
      {subtitle && <Text style={styles.muted}>{subtitle}</Text>}
    </View>
  );
}

// Illustrative jewel drawn with views (no photographs exist yet, and none are invented). Colors are
// tones of the metal, not brand claims; the label says it is an illustration.
const METAL_TONE: Record<Metal, string> = {
  GOLD_18K_YELLOW: "#D4AF37",
  GOLD_18K_WHITE: "#E3E1DA",
  GOLD_18K_ROSE: "#D9A08A",
  SILVER_925: "#C9CBD0",
  PLATINUM_950: "#B8BAC2",
};
const STONE_TONE: Record<string, string> = { DIAMOND: "#F4F7FB", EMERALD: "#2E8B57", RUBY: "#B3263A", SAPPHIRE: "#2F4F9F" };

export function JewelIllustration({ metal, stone, size, label, style }: {
  metal: Metal; stone?: string; size: number; label: string; style?: StyleProp<ViewStyle>;
}) {
  const ring = size * 0.56;
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={label} style={[styles.art, { height: size }, style]}>
      <View style={{ width: ring, height: ring, borderRadius: ring / 2, borderWidth: Math.max(3, ring * 0.09), borderColor: METAL_TONE[metal] }} />
      {stone && (
        <View style={{
          position: "absolute", top: size / 2 - ring / 2 - ring * 0.08, width: ring * 0.22, height: ring * 0.22,
          transform: [{ rotate: "45deg" }], backgroundColor: STONE_TONE[stone] ?? c.text, borderWidth: 1, borderColor: METAL_TONE[metal],
        }} />
      )}
    </View>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.background },
  banner: { backgroundColor: c.surface, color: c.warning, paddingHorizontal: s[3], paddingVertical: s[1], fontSize: type[1] },
  header: { paddingHorizontal: s[4], paddingTop: s[3], paddingBottom: s[2], gap: s[0] },
  title: { color: c.text, fontSize: type[5], fontWeight: "600" },
  body: { color: c.text, fontSize: type[2], lineHeight: type[2] * 1.5 },
  muted: { color: c.textMuted, fontSize: type[1], lineHeight: type[1] * 1.5 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: s[5], gap: s[3] },
  centerText: { textAlign: "center" },
  back: { minHeight: tokens.touchTargetDp, justifyContent: "center", alignSelf: "flex-start" },
  backText: { color: c.accent, fontSize: type[2] },
  button: {
    minHeight: tokens.touchTargetDp, borderRadius: tokens.radius[0], backgroundColor: c.accent, alignItems: "center", justifyContent: "center",
    paddingHorizontal: s[4],
  },
  secondary: { backgroundColor: "transparent", borderWidth: 1, borderColor: c.accent },
  buttonText: { color: c.onAccent, fontSize: type[2], fontWeight: "600" },
  art: { backgroundColor: c.surface, borderRadius: tokens.radius[1], alignItems: "center", justifyContent: "center", overflow: "hidden" },
});
