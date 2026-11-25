import tokens from "@aurea/tokens";
import { useCallback, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { CATEGORIES, type Category } from "../api";
import { usePaged } from "../paged";
import { useSession } from "../session";
import { Button, c, errorKey, Header, Loading, Notice, s, styles, type } from "../ui";
import { ProductCard } from "./ProductCard";

export function CatalogScreen({ onOpen }: { onOpen: (id: string) => void }) {
  const { t, api } = useSession();
  const [category, setCategory] = useState<Category | null>(null);
  const load = useCallback((cursor: string | null) => api.listProducts({ cursor, category }), [api, category]);
  const { state, reload, refresh, loadMore } = usePaged(load, category ?? "all");

  return (
    <View style={styles.screen}>
      <Header title={t("catalogTitle")} subtitle={t("catalogSubtitle")} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={chips.row} style={chips.bar}
        accessibilityRole="tablist">
        {[null, ...CATEGORIES].map((cat) => {
          const selected = cat === category;
          const label = cat ? t(`category_${cat}`) : t("allCategories");
          return (
            <Pressable key={cat ?? "all"} accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected }}
              onPress={() => setCategory(cat)} style={[chips.chip, selected && chips.selected]}>
              <Text style={[chips.text, selected && chips.selectedText]}>{label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
      {state.phase === "loading" && <Loading label={t("loadingCatalog")} />}
      {state.phase === "error" && <Notice alert message={t(errorKey(state.error))} action={{ label: t("retry"), onPress: reload }} />}
      {state.phase === "ready" && state.items.length === 0 && (
        category
          ? <Notice message={t("emptyCategory")} action={{ label: t("showAll"), onPress: () => setCategory(null) }} />
          : <Notice message={t("emptyCatalog")} action={{ label: t("retry"), onPress: reload }} />
      )}
      {state.phase === "ready" && state.items.length > 0 && (
        <FlatList
          data={state.items}
          keyExtractor={(p) => p.id}
          numColumns={2}
          contentContainerStyle={{ padding: s[2], paddingBottom: s[5] }}
          renderItem={({ item }) => <ProductCard product={item} onOpen={() => onOpen(item.id)} />}
          onEndReached={() => { if (state.more === "idle") void loadMore(); }}
          onEndReachedThreshold={0.5}
          refreshControl={<RefreshControl refreshing={state.refreshing} onRefresh={refresh} tintColor={c.accent} colors={[c.accent]} />}
          ListFooterComponent={
            <View style={{ padding: s[3], gap: s[2] }}>
              {state.more === "loading" && (
                <View accessible accessibilityLiveRegion="polite" accessibilityLabel={t("loadingMore")}><ActivityIndicator color={c.accent} /></View>
              )}
              {state.more === "failed" && (
                <>
                  <Text accessibilityRole="alert" style={[styles.muted, styles.centerText]}>{t("loadMoreFailed")}</Text>
                  <Button variant="secondary" label={t("retry")} onPress={() => void loadMore()} />
                </>
              )}
              <Text style={[styles.muted, styles.centerText]}>{t("demoNotice")}</Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const chips = StyleSheet.create({
  bar: { flexGrow: 0 },
  row: { paddingHorizontal: s[3], gap: s[1], paddingBottom: s[2] },
  chip: {
    minHeight: tokens.touchTargetDp, paddingHorizontal: s[3], borderRadius: tokens.touchTargetDp / 2, borderWidth: 1,
    borderColor: c.inputBorder, justifyContent: "center",
  },
  selected: { backgroundColor: c.accent, borderColor: c.accent },
  text: { color: c.text, fontSize: type[1] },
  selectedText: { color: c.onAccent, fontWeight: "600" },
});
