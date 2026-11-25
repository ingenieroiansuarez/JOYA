// Display formatting without floating point: amounts arrive as exact decimal strings (OpenAPI Money)
// and are grouped as text, so 2850000.10 can never render as 2850000.0999.
import type { Locale } from "./i18n";

const SEPARATORS: Record<Locale, { group: string; decimal: string }> = {
  es: { group: ".", decimal: "," }, // es-CO
  en: { group: ",", decimal: "." },
};
// ISO 4217 minor units for the currencies the pilot can show; unknown ones keep their given decimals.
const MINOR_UNITS: Record<string, number> = { COP: 2, USD: 2, EUR: 2 };

export function formatMoney(amount: string, currency: string, locale: Locale): string {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(amount);
  if (!m) return `${amount} ${currency}`;
  const { group, decimal } = SEPARATORS[locale];
  const integer = m[1].replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, group);
  let fraction = (m[2] ?? "").replace(/0+$/, "");
  const minor = MINOR_UNITS[currency];
  if (fraction && minor !== undefined) fraction = fraction.padEnd(minor, "0");
  return `$ ${integer}${fraction ? decimal + fraction : ""} ${currency}`;
}

/** "4.200" g → "4,2 g" (es) / "4.2 g" (en). Explicit unit, never rounded. */
export function formatDecimal(value: string, unit: string, locale: Locale): string {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!m) return `${value} ${unit}`;
  const fraction = (m[2] ?? "").replace(/0+$/, "");
  return `${m[1]}${fraction ? SEPARATORS[locale].decimal + fraction : ""} ${unit}`;
}
