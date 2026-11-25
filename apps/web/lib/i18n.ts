import en from "../messages/en.json";
import es from "../messages/es.json";

import { type Locale } from "./locale";
export { DEFAULT_LOCALE, LOCALES, pickLocale, type Locale } from "./locale";
type Messages = typeof es;

const catalogs: Record<Locale, Messages> = { es, en };

/** Looks up a dotted key and fills {placeholders}. A missing key throws: no silent fallback text. */
export function translator(locale: Locale) {
  return (key: string, vars: Record<string, string> = {}): string => {
    const value = key.split(".").reduce<unknown>((node, k) => (node as Record<string, unknown>)?.[k], catalogs[locale]);
    if (typeof value !== "string") throw new Error(`missing message ${locale}:${key}`);
    return value.replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? `{${name}}`);
  };
}
