import en from "./messages/en.json";
import es from "./messages/es.json";

export type Key = keyof typeof es;
const catalogs = { es, en } as const;
export type Locale = keyof typeof catalogs;

/** Device language when supported, Spanish otherwise. */
export function deviceLocale(tag = Intl.DateTimeFormat().resolvedOptions().locale): Locale {
  return tag.toLowerCase().startsWith("en") ? "en" : "es";
}

export function translator(locale: Locale) {
  return (key: Key, vars: Record<string, string> = {}): string =>
    catalogs[locale][key].replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? `{${name}}`);
}
