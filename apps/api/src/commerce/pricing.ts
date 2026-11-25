// Server-side pricing (15_COMMERCE_AND_PAYMENTS/COMMERCE.md). Pure: same rules + same revision +
// same geometry evidence → the same snapshot and digest. Prices are never computed on a client.
import { FAMILIES, material, type DesignDocument } from "@aurea/design";
import { add, ceilPlaces, cmp, dec, div, mul, roundPlaces, roundTo, str, sub, ZERO, type Dec } from "./money";

export interface PricingRules {
  ruleVersion: string;
  status: "DEMO_SYNTHETIC" | "APPROVED";
  currency: string;
  currencyScale: number;
  roundTo: string;
  termsVersion: string;
  rates: { source: string; date: string; fx: null | { base: string; rate: string; source: string; date: string }; metalPerGram: Record<string, string> };
  lossAllowance: string;
  labor: Record<string, string>;
  finishing: string;
  packaging: string;
  margin: string;
  tax: { code: string; rate: string; status: string };
  depositRate: string;
  quoteValidityDays: number;
  reservationHours: number;
  reserveAllowance: string;
}

export class RulesError extends Error {}

const DECIMAL = /^\d+(\.\d{1,6})?$/;
const FRACTION = (v: string) => DECIMAL.test(v) && cmp(dec(v), dec("1")) < 0;

/** Validates a rules file; throws RulesError naming the first bad field (never a value). */
export function validateRules(r: PricingRules): PricingRules {
  const need = (ok: boolean, field: string) => { if (!ok) throw new RulesError(`pricing rules: invalid ${field}`); };
  need(typeof r?.ruleVersion === "string" && /^[a-z0-9][a-z0-9.-]{2,63}$/.test(r.ruleVersion), "ruleVersion");
  need(r.status === "DEMO_SYNTHETIC" || r.status === "APPROVED", "status");
  need(/^[A-Z]{3}$/.test(r.currency), "currency");
  need(Number.isInteger(r.currencyScale) && r.currencyScale >= 0 && r.currencyScale <= 6, "currencyScale");
  need(DECIMAL.test(r.roundTo) && dec(r.roundTo) > 0n, "roundTo");
  need(typeof r.termsVersion === "string" && r.termsVersion.length > 0 && r.termsVersion.length <= 64, "termsVersion");
  need(typeof r.rates?.source === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.rates?.date ?? ""), "rates");
  need(r.rates.fx === null, "rates.fx (only single-currency pricing exists in hito 500)");
  for (const [id, v] of Object.entries(r.rates.metalPerGram ?? {})) need(!!material(id) && DECIMAL.test(v), `rates.metalPerGram.${id}`);
  for (const [id, v] of Object.entries(r.labor ?? {})) need(FAMILIES.some((f) => f.id === id) && DECIMAL.test(v), `labor.${id}`);
  for (const k of ["finishing", "packaging"] as const) need(DECIMAL.test(r[k]), k);
  for (const k of ["lossAllowance", "margin", "depositRate", "reserveAllowance"] as const) need(FRACTION(r[k]), k);
  need(typeof r.tax?.code === "string" && FRACTION(r.tax?.rate ?? ""), "tax");
  need(Number.isInteger(r.quoteValidityDays) && r.quoteValidityDays >= 1 && r.quoteValidityDays <= 90, "quoteValidityDays");
  need(Number.isInteger(r.reservationHours) && r.reservationHours >= 1 && r.reservationHours <= 720, "reservationHours");
  return r;
}

/** Geometry evidence for the revision: a succeeded job whose result is exactly this design. */
export interface GeometryEvidence {
  jobId: string;
  engineVersion: string;
  dfmState: string;
  components: { id: string; family: string; materialId: string; massGramsEstimate: string; densityStatus: string }[];
}

export interface Label { es: string; en: string }
export interface Line { code: string; label: Label; amount: string }

export interface PricingSnapshot {
  schemaVersion: 1;
  ruleVersion: string;
  rulesStatus: PricingRules["status"];
  currency: string;
  rates: { source: string; date: string; fx: null; metalPerGram: Record<string, string> };
  revision: { id: string; number: number; digest: string };
  geometry: { jobId: string; engineVersion: string; dfmState: string };
  bom: { componentId: string; family: string; materialId: string; massGrams: string; densityStatus: string; reserveGrams: string }[];
  /** What the customer sees: commercial lines that add up to `subtotal`. */
  lines: Line[];
  subtotal: string;
  tax: { code: string; rate: string; amount: string; status: string };
  total: string;
  deposit: { rate: string; amount: string };
  /** Private (COMMERCE.md: internal costs only for authorized staff). Never sent to a customer. */
  internal: { costLines: Line[]; cost: string; margin: string; grossProfit: string };
}

export class PricingError extends Error {
  constructor(readonly code: "UNPRICED_MATERIAL" | "UNPRICED_FAMILY" | "GEOMETRY_MISMATCH", readonly pointer: string) {
    super(code);
  }
}

const P = 6;

export function priceRevision(
  rules: PricingRules,
  rev: { id: string; number: number; digest: string; document: DesignDocument },
  geo: GeometryEvidence,
): PricingSnapshot {
  const scale = rules.currencyScale;
  const step = dec(rules.roundTo);
  const money = (d: Dec) => str(roundPlaces(d, scale), P);
  const keep = 1n * 10n ** 6n as Dec; // 1.000000
  const loss = add(keep, dec(rules.lossAllowance));
  const reserve = add(keep, dec(rules.reserveAllowance));
  const byId = new Map(geo.components.map((c) => [c.id, c]));

  const bom: PricingSnapshot["bom"] = [];
  const metalCost = new Map<string, Dec>();
  let labor = ZERO;
  for (const [i, comp] of rev.document.components.entries()) {
    const m = byId.get(comp.id);
    if (!m || m.materialId !== comp.materialId || m.family !== comp.family) throw new PricingError("GEOMETRY_MISMATCH", `/components/${i}`);
    const rate = rules.rates.metalPerGram[comp.materialId];
    if (!rate) throw new PricingError("UNPRICED_MATERIAL", `/components/${i}/materialId`);
    const fam = rules.labor[comp.family];
    if (!fam) throw new PricingError("UNPRICED_FAMILY", `/components/${i}/family`);
    const mass = dec(m.massGramsEstimate);
    bom.push({
      componentId: comp.id, family: comp.family, materialId: comp.materialId, massGrams: str(mass, 3),
      densityStatus: m.densityStatus, reserveGrams: str(ceilPlaces(mul(mass, reserve), 3), 3),
    });
    metalCost.set(comp.materialId, add(metalCost.get(comp.materialId) ?? ZERO, mul(mul(mass, loss), dec(rate))));
    labor = add(labor, dec(fam));
  }
  const materials = [...metalCost.keys()].sort();
  const costLines: Line[] = [
    ...materials.map((id) => ({ code: `METAL:${id}`, label: metalLabel(id), amount: money(metalCost.get(id)!) })),
    { code: "LABOR", label: { es: "Mano de obra", en: "Labour" }, amount: money(labor) },
    { code: "FINISHING", label: { es: "Acabado", en: "Finishing" }, amount: money(dec(rules.finishing)) },
    { code: "PACKAGING", label: { es: "Empaque", en: "Packaging" }, amount: money(dec(rules.packaging)) },
  ];
  const cost = add(...costLines.map((l) => dec(l.amount)));
  const keepShare = sub(keep, dec(rules.margin)); // price = cost / (1 − margin), never cost × (1 + margin)
  const subtotal = roundTo(div(cost, keepShare), step);
  // Commercial lines: the metal at its marked-up value, rounded; the rest is workmanship, so the
  // lines always add up to the subtotal exactly.
  const metalLines = materials.map((id) => ({ code: `METAL:${id}`, label: metalLabel(id), amount: str(roundTo(div(metalCost.get(id)!, keepShare), step), P) }));
  const metalSum = add(...metalLines.map((l) => dec(l.amount)));
  const workmanship = sub(subtotal, metalSum);
  const lines: Line[] = [...metalLines, { code: "WORKMANSHIP", label: { es: "Hechura, acabado y empaque", en: "Workmanship, finishing and packaging" }, amount: str(workmanship, P) }];
  const tax = roundPlaces(mul(subtotal, dec(rules.tax.rate)), scale);
  const total = add(subtotal, tax);
  const deposit = roundTo(mul(total, dec(rules.depositRate)), step);
  return {
    schemaVersion: 1,
    ruleVersion: rules.ruleVersion,
    rulesStatus: rules.status,
    currency: rules.currency,
    rates: { source: rules.rates.source, date: rules.rates.date, fx: null, metalPerGram: Object.fromEntries(materials.map((id) => [id, rules.rates.metalPerGram[id]])) },
    revision: { id: rev.id, number: rev.number, digest: rev.digest },
    geometry: { jobId: geo.jobId, engineVersion: geo.engineVersion, dfmState: geo.dfmState },
    bom,
    lines,
    subtotal: str(subtotal, P),
    tax: { code: rules.tax.code, rate: rules.tax.rate, amount: str(tax, P), status: rules.tax.status },
    total: str(total, P),
    deposit: { rate: rules.depositRate, amount: str(deposit, P) },
    internal: { costLines, cost: str(cost, P), margin: rules.margin, grossProfit: str(sub(subtotal, cost), P) },
  };
}

function metalLabel(id: string): Label {
  const m = material(id) as { name?: Label } | undefined;
  return m?.name ? { es: m.name.es, en: m.name.en } : { es: id, en: id };
}

/** Metal to reserve per material, summed over the BOM (grams, 3 decimals). */
export function reserveByMaterial(snapshot: PricingSnapshot): Map<string, string> {
  const out = new Map<string, Dec>();
  for (const b of snapshot.bom) out.set(b.materialId, add(out.get(b.materialId) ?? ZERO, dec(b.reserveGrams)));
  return new Map([...out].map(([k, v]) => [k, str(v, 3)]));
}
