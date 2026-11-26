// Shared building blocks. Every control is at least tokens.touchTargetDp tall, carries an
// accessibility role and label, and status text is announced (live region or alert role).
import tokens from "@aurea/tokens";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { CATALOG_ART } from "./catalogArt.generated";
import type { ApiError } from "./api";
import type { Key } from "./i18n";
import type { Metal } from "./api";

export const c = tokens.themes.dark;
export const s = tokens.space;
export const type = tokens.typography.scale;
/**
 * Families. Display: Cormorant Garamond (SIL OFL 1.1, files and hashes in assets/fonts/FONTS.json),
 * embedded at build time by the expo-font plugin (app.json), so it never loads over the network. The
 * family name is the file name. Body text stays the system sans until Inter is bundled the same way.
 */
export const fonts = {
  display: "CormorantGaramond_500Medium",
  /** Prices and measures: the same face, heavier, so figures stay legible at small sizes. */
  displayStrong: "CormorantGaramond_600SemiBold",
  body: undefined as string | undefined,
};
/** Cormorant draws old-style figures by default; names like "PR40" and measures read better lining. */
export const LINING: ("lining-nums")[] = ["lining-nums"];

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
      {/* A label never breaks mid-word: it shrinks a little, then ellipsizes, inside narrow buttons. */}
      <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}
        style={[styles.buttonText, variant === "secondary" && { color: c.accent }]}>{label}</Text>
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

export function Header({ title, subtitle, onBack, backLabel, overline }: {
  title: string; subtitle?: string; onBack?: () => void; backLabel?: string; overline?: string;
}) {
  return (
    <View style={styles.header}>
      {onBack && (
        <Pressable accessibilityRole="button" accessibilityLabel={backLabel} onPress={onBack} hitSlop={8} style={styles.back}>
          <Text style={styles.backText}>‹ {backLabel}</Text>
        </Pressable>
      )}
      {overline && <Text style={styles.overline}>{overline}</Text>}
      {!!title && <Text accessibilityRole="header" style={styles.title}>{title}</Text>}
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

export const hasCatalogArt = (sku: string): boolean => CATALOG_ART[sku] !== undefined;

/**
 * Catalog piece image: the studio render of that SKU (tools/jewel-renders, a 3D illustration of the
 * synthetic piece, not a photograph or a CAD solid), or the drawn illustration when there is none.
 */
export function JewelArt({ sku, metal, stone, label, style }: {
  sku: string; metal: Metal; stone?: string; label: string; style?: StyleProp<ViewStyle>;
}) {
  const art = CATALOG_ART[sku];
  if (art === undefined) return <JewelIllustration metal={metal} stone={stone} size={180} label={label} style={[{ aspectRatio: 1, height: undefined }, style]} />;
  return (
    <View accessible={!!label} accessibilityRole={label ? "image" : undefined} accessibilityLabel={label || undefined}
      importantForAccessibility={label ? "yes" : "no-hide-descendants"} style={[styles.artFrame, style]}>
      <Image source={art} style={styles.artImage} resizeMode="cover" />
    </View>
  );
}

export const styles = StyleSheet.create({
  artFrame: { aspectRatio: 1, width: "100%", backgroundColor: "#141416", overflow: "hidden" },
  artImage: { width: "100%", height: "100%" },
  screen: { flex: 1, backgroundColor: c.background },
  banner: { backgroundColor: c.surface, color: c.warning, paddingHorizontal: s[3], paddingVertical: s[1], fontSize: type[1] },
  // A hairline under a fixed header, so content scrolling beneath it reads as passing under, not cut off.
  header: { paddingHorizontal: s[4], paddingTop: s[3], paddingBottom: s[2], gap: s[0], borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "rgba(197,160,89,0.22)" },
  title: { color: c.text, fontSize: type[5], fontFamily: fonts.display, fontVariant: LINING, letterSpacing: 0.2 },
  overline: { color: c.accent, fontSize: type[0], letterSpacing: 2.4, textTransform: "uppercase", fontWeight: "600" },
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
