// Shared look of the quote and order screens: the piece's journey as steps, cards with a hairline gold
// edge, and the total in the display face. Presentation only: every state shown comes from the API.
import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { OrderState, QuoteState } from "../commerce/client";
import type { Key } from "../i18n";
import { c, fonts, s, styles, type } from "../ui";

export const JOURNEY: readonly Key[] = ["step_review", "step_price", "step_order", "step_deposit", "step_workshop", "step_delivery"];

/** Index of the current step, or null when the journey stopped (lapsed, declined or cancelled). */
export function quoteStep(state: QuoteState): number | null {
  return state === "DRAFT" ? 0 : state === "ISSUED" ? 1 : state === "ACCEPTED" ? 2 : null;
}
export function orderStep(state: OrderState): number | null {
  switch (state) {
    case "PENDING_PAYMENT": return 3;
    case "CONFIRMED": return 4;
    case "FULFILLING": return 4;
    case "READY": return 5;
    case "DELIVERED": return 6; // every step done
    default: return null;
  }
}

/** Steps with the current one marked; done steps in gold, the rest muted. */
export function Journey({ current, t }: { current: number; t: (k: Key, v?: Record<string, string>) => string }) {
  const label = current >= JOURNEY.length ? t("journeyDone")
    : t("journeyA11y", { n: String(current + 1), total: String(JOURNEY.length), step: t(JOURNEY[current]) });
  return (
    <View accessible accessibilityLabel={label} style={j.wrap}>
      <View style={j.track}>
        {JOURNEY.map((k, i) => (
          <View key={k} style={j.cell}>
            <View style={[j.dot, i < current && j.done, i === current && j.now]} />
            {i < JOURNEY.length - 1 && <View style={[j.line, i < current && { backgroundColor: c.accent }]} />}
          </View>
        ))}
      </View>
      <View style={j.labels}>
        {JOURNEY.map((k, i) => (
          <Text key={k} numberOfLines={1} style={[j.label, i <= current && { color: i === current ? c.text : c.accent }]}>{t(k)}</Text>
        ))}
      </View>
    </View>
  );
}

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <View style={j.card}>
      {title && <Text accessibilityRole="header" style={j.cardTitle}>{title}</Text>}
      {children}
    </View>
  );
}

export function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <View style={j.row} accessible accessibilityLabel={`${k}: ${v}`}>
      <Text style={[styles.muted, { flex: 1 }]}>{k}</Text>
      <Text style={[styles.body, { fontVariant: ["tabular-nums"] }]}>{v}</Text>
    </View>
  );
}

/** The amount that matters, large and in the display face. */
export function Total({ k, v }: { k: string; v: string }) {
  return (
    <View style={j.total} accessible accessibilityLabel={`${k}: ${v}`}>
      <Text style={j.totalKey}>{k}</Text>
      <Text style={j.totalValue}>{v}</Text>
    </View>
  );
}

/** One-line state with a coloured lead dot. */
export function Status({ text, tone = "accent" }: { text: string; tone?: "accent" | "success" | "warning" | "danger" }) {
  const color = c[tone];
  return (
    <View style={j.status}>
      <View style={[j.statusDot, { backgroundColor: color }]} />
      <Text accessibilityLiveRegion="polite" style={[j.statusText]}>{text}</Text>
    </View>
  );
}

export const qs = StyleSheet.create({
  // Room under the last button so it scrolls clear of the tab bar and the system navigation.
  content: { padding: s[4], gap: s[4], paddingBottom: s[4] * 4 },
  hero: { flexDirection: "row", gap: s[3], alignItems: "center" },
  heroArt: { width: 96, borderRadius: 10 },
  heroBody: { flex: 1, gap: s[0] },
  heroTitle: { color: c.text, fontSize: type[4], fontFamily: fonts.display },
});

const GOLD_EDGE = "rgba(197,160,89,0.22)";
const j = StyleSheet.create({
  wrap: { gap: s[1] },
  track: { flexDirection: "row", alignItems: "center" },
  cell: { flex: 1, flexDirection: "row", alignItems: "center" },
  dot: { width: 10, height: 10, borderRadius: 5, borderWidth: 1, borderColor: c.textMuted },
  done: { backgroundColor: c.accent, borderColor: c.accent },
  now: { borderColor: c.accent, borderWidth: 2, width: 14, height: 14, borderRadius: 7 },
  line: { flex: 1, height: StyleSheet.hairlineWidth * 2, backgroundColor: c.textMuted, opacity: 0.5, marginHorizontal: 2 },
  labels: { flexDirection: "row" },
  label: { flex: 1, color: c.textMuted, fontSize: type[0] - 1, letterSpacing: 0.4 },
  card: { backgroundColor: c.surface, borderRadius: 12, padding: s[3], gap: s[2], borderWidth: StyleSheet.hairlineWidth, borderColor: GOLD_EDGE },
  cardTitle: { color: c.textMuted, fontSize: type[0], letterSpacing: 1.6, textTransform: "uppercase", fontWeight: "600" },
  row: { flexDirection: "row", justifyContent: "space-between", gap: s[3] },
  total: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: GOLD_EDGE, paddingTop: s[2], gap: 2 },
  totalKey: { color: c.accent, fontSize: type[0], letterSpacing: 1.6, textTransform: "uppercase", fontWeight: "600" },
  totalValue: { color: c.text, fontSize: type[5], fontFamily: fonts.displayStrong, fontVariant: ["lining-nums", "tabular-nums"] },
  status: { flexDirection: "row", alignItems: "center", gap: s[2] },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { color: c.text, fontSize: type[3], fontFamily: fonts.display, flex: 1 },
});

/** A change "from → to", the new value in gold; read as one sentence. */
export function ChangeLine({ label, from, to }: { label: string; from: string; to: string }) {
  return (
    <View accessible accessibilityLabel={`${label}: ${from} → ${to}`} style={x.change}>
      <Text style={[styles.muted, { flex: 1 }]}>{label}</Text>
      <Text style={styles.muted}>{from}</Text>
      <Text style={x.arrow}>→</Text>
      <Text style={x.to}>{to}</Text>
    </View>
  );
}

/** Measured value as a tile: small caps label over a display-face number. */
export function Tile({ k, v }: { k: string; v: string }) {
  return (
    <View accessible accessibilityLabel={`${k}: ${v}`} style={x.tile}>
      <Text style={x.tileKey}>{k}</Text>
      <Text style={x.tileValue}>{v}</Text>
    </View>
  );
}
export const tileGrid = StyleSheet.create({ grid: { flexDirection: "row", flexWrap: "wrap", gap: s[2] } }).grid;
export const goldCard = StyleSheet.create({
  card: { backgroundColor: c.surface, borderRadius: 12, padding: s[3], gap: s[2], borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(197,160,89,0.22)" },
}).card;

const x = StyleSheet.create({
  change: { flexDirection: "row", alignItems: "baseline", gap: s[1] },
  arrow: { color: c.accent, fontSize: type[1] },
  to: { color: c.text, fontSize: type[2], fontWeight: "600" },
  tile: { flexBasis: "47%", flexGrow: 1, backgroundColor: c.background, borderRadius: 8, padding: s[2], gap: 2 },
  tileKey: { color: c.textMuted, fontSize: type[0], letterSpacing: 1.2, textTransform: "uppercase" },
  tileValue: { color: c.text, fontSize: type[3] + 2, fontFamily: fonts.displayStrong, fontVariant: ["lining-nums", "tabular-nums"] },
});
