import { headers } from "next/headers";
import { pickLocale, translator, type Locale } from "../i18n";
import { api, requireSession, type Ctx, type Me } from "./api";

export type Panel = { ctx: Ctx; me: Me; locale: Locale; t: ReturnType<typeof translator> };

/** Session + /v1/me for a panel route. `notConfigured` when the BFF is not set up; `error` when the API is down. */
export async function panelContext(path: string): Promise<Panel | { notConfigured: string; t: ReturnType<typeof translator> } | { error: string; t: ReturnType<typeof translator> }> {
  const locale = pickLocale((await headers()).get("accept-language"));
  const t = translator(locale);
  const s = await requireSession(path);
  if ("notConfigured" in s) return { notConfigured: s.notConfigured, t };
  const me = await api<Me>(s, "GET", "/me", { locale });
  if (!me.ok) return { error: me.error.message || me.error.code, t };
  return { ctx: s, me: me.body, locale, t };
}

export const can = (me: Me, permission: string) => me.permissions.includes(permission);
