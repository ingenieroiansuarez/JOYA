import tokens from "@aurea/tokens";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ProductSummary } from "../api";
import { formatMoney } from "../format";
import { useSession } from "../session";
import { c, fonts, JewelArt, s, type } from "../ui";

export function ProductCard({ product, onOpen }: { product: ProductSummary; onOpen: () => void }) {
  const { t, locale, favorites } = useSession();
  const price = formatMoney(product.price.amount, product.price.currency, locale);
  const metal = t(`metal_${product.metal}`);
  const saved = favorites.has(product.id);
  const label = [product.name, metal, price, product.available ? t("available") : t("soldOut"), saved ? t("tabFavorites") : null]
    .filter(Boolean).join(", ");
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onOpen}
      style={({ pressed }) => [card.root, pressed && card.pressed]}>
      <View importantForAccessibility="no-hide-descendants">
        <JewelArt sku={product.sku} metal={product.metal} label="" />
        {saved && <View style={card.fav}><Text style={card.favText}>♥</Text></View>}
        {!product.available && <Text style={card.soldOut}>{t("soldOut")}</Text>}
        <View style={card.text}>
          <Text style={card.meta} numberOfLines={1}>{metal}</Text>
          <Text style={card.name} numberOfLines={2}>{product.name}</Text>
          <Text style={card.price}>{price}</Text>
        </View>
      </View>
    </Pressable>
  );
}

const card = StyleSheet.create({
  root: {
    flex: 1, margin: s[1], borderRadius: tokens.radius[1], backgroundColor: c.surface, overflow: "hidden", minHeight: tokens.touchTargetDp,
    borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(197,160,89,0.22)",
  },
  pressed: { opacity: 0.85, transform: [{ scale: 0.98 }] },
  text: { paddingHorizontal: s[2], paddingTop: s[2], paddingBottom: s[3], gap: 2 },
  meta: { color: c.textMuted, fontSize: type[0], letterSpacing: 1.2, textTransform: "uppercase" },
  name: { color: c.text, fontSize: type[3], fontFamily: fonts.display, lineHeight: type[3] * 1.2 },
  price: { color: c.accent, fontSize: type[1], fontWeight: "600", marginTop: s[0], letterSpacing: 0.3 },
  fav: {
    position: "absolute", right: s[2], top: s[2], width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(12,12,13,0.7)",
  },
  favText: { color: c.accent, fontSize: type[1] },
  soldOut: {
    position: "absolute", left: s[2], top: s[2], color: c.warning, fontSize: type[0], letterSpacing: 1, textTransform: "uppercase",
    backgroundColor: "rgba(12,12,13,0.75)", paddingHorizontal: s[1], paddingVertical: 2, borderRadius: 4, overflow: "hidden",
  },
});
