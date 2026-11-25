export const LOCALES = ["es", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "es";

/**
 * The supported language the browser prefers most (RFC 9110 Accept-Language): highest q wins,
 * header order breaks ties, q=0 means "not this one". Spanish when nothing supported is acceptable.
 */
export function pickLocale(acceptLanguage: string | null): Locale {
  let best: { locale: Locale; q: number } | null = null;
  for (const part of (acceptLanguage ?? "").split(",")) {
    const [range, ...params] = part.split(";").map((x) => x.trim());
    const tag = range.toLowerCase().split("-")[0];
    if (!(LOCALES as readonly string[]).includes(tag)) continue;
    const qParam = params.find((p) => /^q=/i.test(p));
    const q = qParam === undefined ? 1 : Number(qParam.slice(2));
    if (!Number.isFinite(q) || q <= 0 || q > 1) continue;
    if (!best || q > best.q) best = { locale: tag as Locale, q };
  }
  return best?.locale ?? DEFAULT_LOCALE;
}
