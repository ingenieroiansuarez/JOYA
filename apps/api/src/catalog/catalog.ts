import { BadRequestException } from "@nestjs/common";

export const CATEGORIES = ["RING", "PENDANT", "EARRINGS", "BRACELET", "NECKLACE"] as const;
export const LOCALES = ["es", "en"] as const;
export type Locale = (typeof LOCALES)[number];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** OpenAPI AcceptLanguage: es or en by q-value order; anything else (or nothing) → es. */
export function pickLocale(header: string | undefined): Locale {
  if (!header) return "es";
  const ranked = header
    .slice(0, 200)
    .split(",")
    .map((part, i) => {
      const [tag, ...params] = part.trim().toLowerCase().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const weight = q ? Number(q.slice(2)) : 1;
      return { lang: tag.split("-")[0], weight: Number.isFinite(weight) ? weight : 0, i };
    })
    .filter((r) => r.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.i - b.i);
  return (ranked.find((r) => (LOCALES as readonly string[]).includes(r.lang))?.lang as Locale) ?? "es";
}

export function parseUuid(value: string): string {
  if (!UUID.test(value)) throw new BadRequestException();
  return value.toLowerCase();
}

export function parseLimit(value: string | undefined): number {
  if (value === undefined) return 20;
  if (!/^\d{1,2}$/.test(value)) throw new BadRequestException();
  const n = Number(value);
  if (n < 1 || n > 50) throw new BadRequestException();
  return n;
}

export function parseCategory(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!(CATEGORIES as readonly string[]).includes(value)) throw new BadRequestException();
  return value;
}

/** Opaque keyset cursor: base64url JSON of the last row's sort key. Anything malformed is a 400. */
export function encodeCursor(key: [string | number, string]): string {
  return Buffer.from(JSON.stringify(key)).toString("base64url");
}

export function decodeCursor<K extends "number" | "string">(value: string | undefined, kind: K): [K extends "number" ? number : string, string] | null {
  if (value === undefined) return null;
  if (value.length > 200 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new BadRequestException();
  let key: unknown;
  try {
    key = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new BadRequestException();
  }
  if (!Array.isArray(key) || key.length !== 2 || typeof key[1] !== "string" || !UUID.test(key[1])) throw new BadRequestException();
  if (kind === "number" ? !Number.isInteger(key[0]) : typeof key[0] !== "string" || Number.isNaN(Date.parse(key[0]))) {
    throw new BadRequestException();
  }
  return key as [K extends "number" ? number : string, string];
}

// Row → OpenAPI shapes. Money and weights stay decimal strings from PostgreSQL; never JS floats.
export interface ProductRow {
  id: string;
  sku: string;
  position: number;
  category: string;
  metal: string;
  metal_weight_g: string;
  stones: unknown[];
  text: { name: string; summary: string; description: string; collection?: string | null };
  currency: string;
  price: string;
  available: boolean;
  customizable: boolean;
}

/** Selects one locale's texts, falling back to es (always present: SQL CHECK). */
export const PRODUCT_COLUMNS = `p.id, p.sku, p.position, p.category, p.metal, p.metal_weight_g::text AS metal_weight_g, p.stones,
  coalesce(p.content -> $1::text, p.content -> 'es') AS text, p.currency, trim_scale(p.price)::text AS price,
  p.available, p.customizable`;

export function toSummary(r: ProductRow) {
  return {
    id: r.id,
    sku: r.sku,
    name: r.text.name,
    category: r.category,
    metal: r.metal,
    price: { amount: r.price, currency: r.currency },
    available: r.available,
    customizable: r.customizable,
  };
}

export function toProduct(r: ProductRow) {
  return {
    id: r.id,
    sku: r.sku,
    name: r.text.name,
    summary: r.text.summary,
    description: r.text.description,
    collection: r.text.collection ?? null,
    category: r.category,
    metal: r.metal,
    metalWeightGrams: r.metal_weight_g,
    stones: r.stones,
    price: { amount: r.price, currency: r.currency },
    available: r.available,
    customizable: r.customizable,
  };
}
