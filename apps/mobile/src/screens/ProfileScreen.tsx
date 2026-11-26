import { ScrollView, Text, View } from "react-native";
import { useSession } from "../session";
import { Button, c, fonts, Header, Loading, s, styles, type } from "../ui";
import { Card } from "./commerce-ui";

export function ProfileScreen() {
  const { t, status, me, signIn, signOut, config } = useSession();
  return (
    <View style={styles.screen}>
      <Header overline={t("brandOverline")} title={t("profileTitle")} />
      <ScrollView contentContainerStyle={{ padding: s[4], gap: s[4] }}>
        {status === "restoring" && <Loading label={t("restoring")} />}
        {status === "signingIn" && <Loading label={t("signingIn")} />}
        {(status === "guest" || status === "failed") && (
          <Card title={t("profileAccount")}>
            <Text style={[styles.body, { fontFamily: fonts.display, fontSize: type[4] }]}>{t("profileWelcome")}</Text>
            <Text style={styles.muted}>{t("profileGuest")}</Text>
            {status === "failed" && <Text accessibilityRole="alert" style={[styles.body, { color: c.danger }]}>{t("signInFailed")}</Text>}
            <Button label={status === "failed" ? t("retry") : t("signIn")} onPress={signIn} />
          </Card>
        )}
        {status === "signedIn" && me && (
          <Card title={t("profileAccount")}>
            <Text style={styles.body}>{t("profileSignedIn")}</Text>
            <Button variant="secondary" label={t("signOut")} onPress={signOut} />
          </Card>
        )}
        <Card title={t("profileAbout")}>
          <Text style={styles.muted}>{t("languageLine", { language: t("languageName") })}</Text>
          {config.env !== "production" && <Text style={[styles.muted, { color: c.warning }]}>{t("demoNotice")}</Text>}
        </Card>
      </ScrollView>
    </View>
  );
}
