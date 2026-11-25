import { headers } from "next/headers";
import { pickLocale, translator } from "../lib/i18n";

export default async function Home() {
  const t = translator(pickLocale((await headers()).get("accept-language")));
  return (
    <>
      <h1>{t("home.title")}</h1>
      <p className="lead">{t("home.lead")}</p>
      <p><a className="button" href="/panel">{t("home.openPanel")}</a></p>
    </>
  );
}
