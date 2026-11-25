import { View } from "react-native";
import { Text } from "react-native";
import { useSession } from "../session";
import { Button, c, Header, Loading, s, styles } from "../ui";

export function ProfileScreen() {
  const { t, status, me, signIn, signOut, config } = useSession();
  return (
    <View style={styles.screen}>
      <Header title={t("profileTitle")} />
      <View style={{ padding: s[4], gap: s[3] }}>
        {status === "restoring" && <Loading label={t("restoring")} />}
        {status === "signingIn" && <Loading label={t("signingIn")} />}
        {(status === "guest" || status === "failed") && (
          <>
            <Text style={styles.body}>{t("profileGuest")}</Text>
            {status === "failed" && <Text accessibilityRole="alert" style={[styles.body, { color: c.danger }]}>{t("signInFailed")}</Text>}
            <Button label={status === "failed" ? t("retry") : t("signIn")} onPress={signIn} />
          </>
        )}
        {status === "signedIn" && me && (
          <>
            <Text style={styles.body}>{t("profileSignedIn")}</Text>
            <Text style={styles.muted}>{t("roles", { roles: me.roles.join(", ") })}</Text>
            <Button variant="secondary" label={t("signOut")} onPress={signOut} />
          </>
        )}
        <Text style={styles.muted}>{t("languageLine", { language: t("languageName") })}</Text>
        {config.env !== "production" && <Text style={styles.muted}>{t("demoNotice")}</Text>}
      </View>
    </View>
  );
}
