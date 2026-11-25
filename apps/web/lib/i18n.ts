import en from "../messages/en.json";
import es from "../messages/es.json";

export const LOCALES = ["es", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "es";
type Messages = typeof es;

const catalogs: Record<Locale, Messages> = { es, en };

/** Picks the first supported language from an Accept-Language header; Spanish otherwise. */
export function pickLocale(acceptLanguage: string | null): Locale {
  for (const part of (acceptLanguage ?? "").split(",")) {
    const tag = part.split(";")[0].trim().toLowerCase().split("-")[0];
    if ((LOCALES as readonly string[]).includes(tag)) return tag as Locale;
  }
  return DEFAULT_LOCALE;
}

/** Looks up a dotted key and fills {placeholders}. A missing key throws: no silent fallback text. */
export function translator(locale: Locale) {
  return (key: string, vars: Record<string, string> = {}): string => {
    const value = key.split(".").reduce<unknown>((node, k) => (node as Record<string, unknown>)?.[k], catalogs[locale]);
    if (typeof value !== "string") throw new Error(`missing message ${locale}:${key}`);
    return value.replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? `{${name}}`);
  };
}
