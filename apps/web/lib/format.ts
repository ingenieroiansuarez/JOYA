export interface Money { amount: string; currency: string }

/** Display only. Amounts arrive as exact decimal strings; COP has no minor unit in display. */
export function formatMoney(m: Money | null | undefined, locale: string): string {
  if (!m) return "—";
  const tag = locale === "en" ? "en-US" : "es-CO";
  const [int, frac = ""] = m.amount.split(".");
  const digits = m.currency === "COP" ? 0 : 2;
  const grouped = new Intl.NumberFormat(tag, { maximumFractionDigits: 0 }).format(BigInt(int));
  const decimals = digits ? (tag === "en-US" ? "." : ",") + frac.padEnd(digits, "0").slice(0, digits) : "";
  return `${m.currency} ${grouped}${decimals}`;
}

export function formatDate(iso: string | null | undefined, locale: string): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat(locale === "en" ? "en-US" : "es-CO", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Bogota" }).format(new Date(iso));
}
