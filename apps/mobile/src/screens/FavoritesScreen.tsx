import { useCallback, useEffect } from "react";
import { FlatList, View } from "react-native";
import { usePaged } from "../paged";
import { useSession } from "../session";
import { Button, errorKey, Header, Loading, Notice, s, styles } from "../ui";
import { ProductCard } from "./ProductCard";

export function FavoritesScreen({ onOpen, onExplore }: { onOpen: (id: string) => void; onExplore: () => void }) {
  const { t, status, signIn } = useSession();
  return (
    <View style={styles.screen}>
      <Header title={t("favoritesTitle")} />
      {status === "restoring" && <Loading label={t("restoring")} />}
      {(status === "guest" || status === "failed" || status === "signingIn") && (
        <View style={[styles.center]}>
          <Notice message={t("favoritesGuest")} />
          {status === "failed" && <Notice alert message={t("signInFailed")} />}
          <Button label={status === "failed" ? t("retry") : t("signIn")} onPress={signIn} disabled={status === "signingIn"} />
        </View>
      )}
      {status === "signedIn" && <SignedInFavorites onOpen={onOpen} onExplore={onExplore} />}
    </View>
  );
}

function SignedInFavorites({ onOpen, onExplore }: { onOpen: (id: string) => void; onExplore: () => void }) {
  const { t, api, withToken, favoritesVersion } = useSession();
  const load = useCallback((cursor: string | null) => withToken((tok) => api.listFavorites(tok, cursor)), [api, withToken]);
  const { state, reload, loadMore } = usePaged(load, "favorites");
  // Saving or removing elsewhere bumps the version: reload so this list matches the server.
  useEffect(() => { if (favoritesVersion > 0) void reload(); }, [favoritesVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  if (state.phase === "loading") return <Loading label={t("loadingFavorites")} />;
  if (state.phase === "error") return <Notice alert message={t(errorKey(state.error))} action={{ label: t("retry"), onPress: reload }} />;
  if (state.items.length === 0) return <Notice message={t("favoritesEmpty")} action={{ label: t("exploreBoutique"), onPress: onExplore }} />;
  return (
    <FlatList
      data={state.items}
      keyExtractor={(p) => p.id}
      numColumns={2}
      contentContainerStyle={{ padding: s[2] }}
      renderItem={({ item }) => <ProductCard product={item} onOpen={() => onOpen(item.id)} />}
      onEndReached={() => { if (state.more === "idle") void loadMore(); }}
    />
  );
}
