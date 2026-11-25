// Loads the synthetic demo catalog (seed/demo-catalog.json) into DATABASE_URL.
// Fails closed: only AUREA_ENV local, ci or demo; production and unknown environments are refused
// before any connection is opened. Idempotent: upserts by fixed id, in one transaction.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { redact } from "./migrate.mjs";

export const SEED_ENVIRONMENTS = ["local", "ci", "demo"];
export const DEMO_CATALOG = fileURLToPath(new URL("../seed/demo-catalog.json", import.meta.url));
export const DEMO_STOCK = fileURLToPath(new URL("../seed/demo-stock.json", import.meta.url));

const DECIMAL_RE = /^\d+(\.\d{1,6})?$/;
// Exact decimal strings only: a JS number (0.25) would be accepted by the regex after coercion.
const DECIMAL = { test: (v) => typeof v === "string" && DECIMAL_RE.test(v) };
const LOCALES = ["es", "en"];

/** Shape checks the database cannot express (stones and texts live in jsonb). Throws on the first problem. */
export function validateCatalog(doc) {
  if (doc?.synthetic !== true) throw new Error("seed file must declare synthetic: true");
  const seen = new Set();
  for (const p of doc.products ?? []) {
    const where = `product ${p.sku ?? p.id}`;
    if (seen.has(p.id) || seen.has(p.sku)) throw new Error(`${where}: duplicate id or sku`);
    seen.add(p.id).add(p.sku);
    if (!DECIMAL.test(p.metalWeightGrams)) throw new Error(`${where}: metalWeightGrams must be a decimal string in grams`);
    if (!DECIMAL.test(p.price?.amount)) throw new Error(`${where}: price.amount must be a decimal string`);
    for (const s of p.stones) {
      if (!Number.isInteger(s.count) || s.count < 1) throw new Error(`${where}: stone count must be a positive integer`);
      if (!DECIMAL.test(s.totalCarats)) throw new Error(`${where}: stone totalCarats must be a decimal string in carats`);
    }
    for (const l of LOCALES) {
      const c = p.content?.[l];
      if (!c?.name || !c.summary || !c.description) throw new Error(`${where}: content.${l} needs name, summary and description`);
    }
  }
  if (seen.size === 0) throw new Error("seed file has no products");
  return doc.products;
}

/** Demo stock (hito 500): one location and metal lots. Throws on the first problem. */
export function validateStock(doc) {
  if (doc?.synthetic !== true) throw new Error("stock file must declare synthetic: true");
  if (!doc.location?.id || !doc.location?.name) throw new Error("stock file needs a location");
  const seen = new Set();
  for (const l of doc.lots ?? []) {
    if (seen.has(l.id)) throw new Error(`lot ${l.id}: duplicate id`);
    seen.add(l.id);
    if (!["g", "ct", "ea"].includes(l.unit)) throw new Error(`lot ${l.id}: unit must be g, ct or ea`);
    if (!DECIMAL.test(l.onHand)) throw new Error(`lot ${l.id}: onHand must be a decimal string`);
    if (!l.itemKey || !l.label) throw new Error(`lot ${l.id}: itemKey and label are required`);
  }
  if (seen.size === 0) throw new Error("stock file has no lots");
  return doc;
}

export async function seedDemo(url, env, file = DEMO_CATALOG, stockFile = DEMO_STOCK) {
  if (!SEED_ENVIRONMENTS.includes(env)) {
    throw new Error(`refusing to seed demo data with AUREA_ENV=${env ?? "<unset>"} (allowed: ${SEED_ENVIRONMENTS.join(", ")})`);
  }
  if (!url) throw new Error("DATABASE_URL is not set; refusing to guess a database");
  const products = validateCatalog(JSON.parse(readFileSync(file, "utf8")));
  const stock = validateStock(JSON.parse(readFileSync(stockFile, "utf8")));
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN");
    for (const p of products) {
      await client.query(
        `INSERT INTO aurea.product(id, sku, position, category, metal, metal_weight_g, stones, content, currency, price,
                                   available, customizable, published_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, CASE WHEN $13::boolean THEN now() END)
         ON CONFLICT (id) DO UPDATE SET sku=$2, position=$3, category=$4, metal=$5, metal_weight_g=$6, stones=$7,
           content=$8, currency=$9, price=$10, available=$11, customizable=$12,
           published_at = CASE WHEN $13::boolean THEN coalesce(aurea.product.published_at, now()) END`,
        [p.id, p.sku, p.position, p.category, p.metal, p.metalWeightGrams, JSON.stringify(p.stones), JSON.stringify(p.content),
          p.price.currency, p.price.amount, p.available, p.customizable, p.published],
      );
    }
    // Stock: a lot is created once with its RECEIPT movement (the ledger is append-only); a re-run
    // never resets quantities that orders have since reserved or that a stockkeeper adjusted.
    const loc = stock.location;
    await client.query(
      "INSERT INTO aurea.location(id, name, kind) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET name=$2, kind=$3",
      [loc.id, loc.name, loc.kind]);
    for (const l of stock.lots) {
      const ins = await client.query(
        `INSERT INTO aurea.stock_lot(id, location_id, item_key, unit, on_hand, label, demo) VALUES ($1,$2,$3,$4,$5,$6,true)
         ON CONFLICT (id) DO NOTHING`, [l.id, loc.id, l.itemKey, l.unit, l.onHand, l.label]);
      if (ins.rowCount) {
        await client.query(
          `INSERT INTO aurea.stock_movement(id, lot_id, quantity_delta, actor, reason, kind, on_hand_after)
           VALUES (gen_random_uuid(), $1, $2, 'seed:demo', 'Existencia inicial sintética (demo)', 'RECEIPT', $2)`, [l.id, l.onHand]);
      }
    }
    await client.query("COMMIT");
    return products.length;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  try {
    const n = await seedDemo(url, process.env.AUREA_ENV);
    console.log(`demo catalog: ${n} synthetic products and the synthetic demo stock upserted into ${redact(url)}`);
  } catch (err) {
    console.error(`demo seed failed: ${err.message}`);
    process.exitCode = 1;
  }
}
