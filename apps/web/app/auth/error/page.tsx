import { headers } from "next/headers";
import { pickLocale, translator } from "../../../lib/i18n";

const REASONS = ["config", "idp", "state", "nonce", "denied"] as const;

export default async function AuthError({ searchParams }: { searchParams: Promise<{ reason?: string }> }) {
  const t = translator(pickLocale((await headers()).get("accept-language")));
  const r = (await searchParams).reason;
  const reason = REASONS.find((x) => x === r) ?? "idp";
  return (
    <>
      <h1>{t("auth.errorTitle")}</h1>
      <p role="alert" className="lead">{t(`auth.reason.${reason}`)}</p>
      {reason !== "config" && <p><a href="/auth/login">{t("auth.retry")}</a></p>}
    </>
  );
}
