import tokens from "@aurea/tokens";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ProductSummary } from "../api";
import { formatMoney } from "../format";
import { useSession } from "../session";
import { c, JewelIllustration, s, type } from "../ui";

export function ProductCard({ product, onOpen }: { product: ProductSummary; onOpen: () => void }) {
  const { t, locale, favorites } = useSession();
  const price = formatMoney(product.price.amount, product.price.currency, locale);
  const metal = t(`metal_${product.metal}`);
  const saved = favorites.has(product.id);
  const label = [product.name, metal, price, product.available ? t("available") : t("soldOut"), saved ? t("tabFavorites") : null]
    .filter(Boolean).join(", ");
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onOpen}
      style={({ pressed }) => [card.root, pressed && { opacity: 0.8 }]}>
      <JewelIllustration metal={product.metal} size={140} label="" style={card.art} />
      <View style={card.text} importantForAccessibility="no-hide-descendants">
        <Text style={card.name} numberOfLines={2}>{product.name}</Text>
        <Text style={card.meta} numberOfLines={1}>{metal}</Text>
        <Text style={card.price}>{price}</Text>
        {!product.available && <Text style={card.soldOut}>{t("soldOut")}</Text>}
        {saved && <Text style={card.saved}>♥</Text>}
      </View>
    </Pressable>
  );
}

const card = StyleSheet.create({
  root: { flex: 1, margin: s[1], borderRadius: tokens.radius[1], backgroundColor: c.surface, overflow: "hidden", minHeight: tokens.touchTargetDp },
  art: { borderRadius: 0 },
  text: { padding: s[2], gap: 2 },
  name: { color: c.text, fontSize: type[2], fontWeight: "600" },
  meta: { color: c.textMuted, fontSize: type[1] },
  price: { color: c.accent, fontSize: type[1], fontWeight: "600", marginTop: s[0] },
  soldOut: { color: c.warning, fontSize: type[1] },
  saved: { position: "absolute", right: s[2], top: s[2], color: c.accent, fontSize: type[2] },
});
