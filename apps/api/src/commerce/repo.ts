// Shared persistence for the commercial slice: scopes, row mapping, stock reservations, events.
import { randomUUID } from "node:crypto";
import { NotFoundException } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { SCOPES } from "../identity/roles.generated";
import type { Principal } from "../identity/principal";
import { ApiError } from "../design/api-error";
import { add, cmp, dec, str, sub, ZERO } from "./money";
import type { Line, PricingSnapshot } from "./pricing";

export type Locale = "es" | "en";
export const localeOf = (h: string | undefined): Locale => (/^en\b/i.test(h ?? "") ? "en" : "es");
export interface AuthedRequest { principal: Principal; header(name: string): string | undefined; rawBody?: Buffer }

const BREADTH = ["public", "self", "session", "own", "shared", "assigned", "location", "organization"];
/** Broadest scope the principal's roles give for a permission (roles.reference.json `scopes`), or null. */
export function scopeOf(p: Principal, permission: string): string | null {
  let best: string | null = null;
  for (const role of p.roles) {
    const s = SCOPES[role]?.[permission];
    if (s && (best === null || BREADTH.indexOf(s) > BREADTH.indexOf(best))) best = s;
  }
  return best;
}
export const has = (p: Principal, permission: string) => p.permissions.includes(permission);

export const bad = (pointer: string, message: string) => new ApiError(400, "VALIDATION_FAILED", [{ code: "VALIDATION_FAILED", pointer, message }]);
export const money = (amount: string, currency: string) => ({ amount: trim(amount), currency });
/** numeric(20,6) text → shortest exact decimal string ("1500.000000" → "1500"). */
export function trim(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}
export function objectBody(raw: unknown, allowed: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad("", "body must be an object");
  const b = raw as Record<string, unknown>;
  const extra = Object.keys(b).filter((k) => !allowed.includes(k));
  if (extra.length) throw bad(`/${extra[0]}`, "unknown property");
  return b;
}
export function moneyBody(v: unknown, pointer: string): { amount: string; currency: string } {
  const m = v as { amount?: unknown; currency?: unknown } | null;
  if (!m || typeof m !== "object" || typeof m.amount !== "string" || !/^\d+(\.\d{1,6})?$/.test(m.amount)
    || typeof m.currency !== "string" || !/^[A-Z]{3}$/.test(m.currency) || Object.keys(m).length !== 2) {
    throw bad(pointer, "Money {amount: decimal string, currency: ISO 4217}");
  }
  return { amount: m.amount, currency: m.currency };
}

// ---------------------------------------------------------------- quotes

export interface QuoteRow {
  id: string; project_id: string; revision_id: string; revision_number: number; customer_id: string; requested_by: string;
  state: string; currency: string; amount: string; deposit_amount: string; snapshot: PricingSnapshot & { terms?: { termsVersion: string; expiresAt: string } };
  digest: string; draft_digest: string; expires_at: string; expired: boolean; terms_version: string | null; issued_by: string | null;
  issued_at: string | null; accepted_at: string | null; decision_reason: string | null; version: number; created_at: string; order_id: string | null;
  project_title: string;
}
export const QUOTE_COLUMNS = `q.id, q.project_id, q.revision_id, r.number AS revision_number, q.customer_id, q.requested_by, q.state, q.currency,
  q.amount::text, q.deposit_amount::text, q.snapshot, q.digest, q.draft_digest, q.expires_at::text, (q.expires_at <= now()) AS expired,
  q.terms_version, q.issued_by, q.issued_at::text, q.accepted_at::text, q.decision_reason, q.version, q.created_at::text,
  o.id AS order_id, p.title AS project_title`;
export const QUOTE_FROM = `aurea.quote q JOIN aurea.revision r ON r.id = q.revision_id JOIN aurea.project p ON p.id = q.project_id
  LEFT JOIN aurea.sales_order o ON o.quote_id = q.id`;

const iso = (s: string | null) => (s ? new Date(s).toISOString() : null);
const line = (l: Line, currency: string, locale: Locale) => ({ code: l.code, label: l.label[locale], amount: money(l.amount, currency) });

export function toQuote(r: QuoteRow, locale: Locale, internal: boolean) {
  const s = r.snapshot;
  const state = r.state === "ISSUED" && r.expired ? "EXPIRED" : r.state;
  return {
    id: r.id, projectId: r.project_id, projectTitle: r.project_title, revisionId: r.revision_id, revisionNumber: r.revision_number,
    state, total: money(r.amount, r.currency), subtotal: money(s.subtotal, r.currency),
    tax: { code: s.tax.code, rate: s.tax.rate, amount: money(s.tax.amount, r.currency) },
    lines: s.lines.map((l) => line(l, r.currency, locale)),
    deposit: { rate: s.deposit.rate, amount: money(r.deposit_amount, r.currency) },
    bom: s.bom.map((b) => ({ componentId: b.componentId, materialId: b.materialId, massGrams: b.massGrams, densityStatus: b.densityStatus })),
    pricing: { ruleVersion: s.ruleVersion, termsVersion: s.termsVersion, simulated: s.rulesStatus !== "APPROVED", ratesSource: s.rates.source, ratesDate: s.rates.date },
    dfmState: s.geometry.dfmState,
    digest: r.digest, termsVersion: r.terms_version,
    expiresAt: new Date(r.expires_at).toISOString(), createdAt: new Date(r.created_at).toISOString(),
    issuedAt: iso(r.issued_at), acceptedAt: iso(r.accepted_at), decisionReason: r.decision_reason, orderId: r.order_id,
    ...(internal ? {
      internal: {
        costLines: s.internal.costLines.map((l) => line(l, r.currency, locale)), cost: money(s.internal.cost, r.currency),
        margin: s.internal.margin, grossProfit: money(s.internal.grossProfit, r.currency),
      },
    } : {}),
  };
}

/**
 * Quote visibility. Customer `own`: their quotes. Advisor `assigned`: the unassigned DRAFT queue and
 * the quotes they issued (there is no assignment table until CRM, hito 700). Anything else → 404.
 */
export function quoteFilter(p: Principal, alias = "q", firstParam = 1): { sql: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];
  const scope = scopeOf(p, "quote.read");
  if (scope === "own" || p.roles.includes("customer")) {
    params.push(p.subject);
    parts.push(`${alias}.customer_id = (SELECT id FROM aurea.customer WHERE subject = $${firstParam + params.length - 1})`);
  }
  if (scope === "assigned") {
    params.push(p.subject);
    parts.push(`(${alias}.state = 'DRAFT' OR ${alias}.issued_by = $${firstParam + params.length - 1})`);
  }
  if (scope === "organization") parts.push("true");
  return { sql: parts.length ? `(${parts.join(" OR ")})` : "false", params };
}

export async function visibleQuote(c: Pool | PoolClient, p: Principal, id: string, lock = false): Promise<QuoteRow> {
  const f = quoteFilter(p, "q", 2);
  const { rows } = await c.query<QuoteRow>(`SELECT ${QUOTE_COLUMNS} FROM ${QUOTE_FROM} WHERE q.id = $1 AND ${f.sql} ${lock ? "FOR UPDATE OF q" : ""}`, [id, ...f.params]);
  if (!rows[0]) throw new NotFoundException();
  return rows[0];
}

// ---------------------------------------------------------------- orders

export interface OrderRow {
  id: string; quote_id: string; customer_id: string; state: string; currency: string; total: string; deposit_required: string;
  cancel_reason: string | null; version: number; created_at: string; updated_at: string; project_id: string; revision_id: string;
  revision_number: number; project_title: string; issued_by: string | null;
}
export const ORDER_COLUMNS = `o.id, o.quote_id, o.customer_id, o.state, o.currency, o.total::text, o.deposit_required::text, o.cancel_reason,
  o.version, o.created_at::text, o.updated_at::text, q.project_id, q.revision_id, r.number AS revision_number, p.title AS project_title, q.issued_by`;
export const ORDER_FROM = `aurea.sales_order o JOIN aurea.quote q ON q.id = o.quote_id JOIN aurea.revision r ON r.id = q.revision_id
  JOIN aurea.project p ON p.id = q.project_id`;

/** Order visibility: customer own; advisor assigned (orders of quotes they issued); organization-wide payment readers (finance). */
export function orderFilter(p: Principal, firstParam = 1): { sql: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];
  const scope = scopeOf(p, "order.read");
  if (scope === "own" || p.roles.includes("customer")) {
    params.push(p.subject);
    parts.push(`o.customer_id = (SELECT id FROM aurea.customer WHERE subject = $${firstParam + params.length - 1})`);
  }
  if (scope === "assigned") {
    params.push(p.subject);
    parts.push(`q.issued_by = $${firstParam + params.length - 1}`);
  }
  if (scope === "organization" || scope === "location" || scopeOf(p, "payment.read") === "organization") parts.push("true");
  return { sql: parts.length ? `(${parts.join(" OR ")})` : "false", params };
}

export async function visibleOrder(c: Pool | PoolClient, p: Principal, id: string, lock = false): Promise<OrderRow> {
  const f = orderFilter(p, 2);
  const { rows } = await c.query<OrderRow>(`SELECT ${ORDER_COLUMNS} FROM ${ORDER_FROM} WHERE o.id = $1 AND ${f.sql} ${lock ? "FOR UPDATE OF o" : ""}`, [id, ...f.params]);
  if (!rows[0]) throw new NotFoundException();
  return rows[0];
}

export interface PaymentRow {
  id: string; order_id: string; kind: string; provider: string; provider_id: string; currency: string; amount: string; state: string;
  simulated: boolean; failure_code: string | null; review_reason: string | null; version: number; created_at: string; confirmed_at: string | null;
  created_by: string;
}
export const PAYMENT_COLUMNS = `id, order_id, kind, provider, provider_id, currency, amount::text, state, simulated, failure_code, review_reason,
  version, created_at::text, confirmed_at::text, created_by`;

export function toPayment(r: PaymentRow) {
  return {
    id: r.id, orderId: r.order_id, kind: r.kind, amount: money(r.amount, r.currency), state: r.state,
    provider: { id: r.provider, simulated: r.simulated }, failureCode: r.failure_code, reviewReason: r.review_reason,
    createdAt: new Date(r.created_at).toISOString(), confirmedAt: iso(r.confirmed_at),
  };
}

interface ReservationRow { id: string; lot_id: string; item_key: string; unit: string; quantity: string; state: string; expires_at: string; label: string }

export async function orderDetail(c: Pool | PoolClient, o: OrderRow) {
  const payments = (await c.query<PaymentRow>(`SELECT ${PAYMENT_COLUMNS} FROM aurea.payment WHERE order_id = $1 ORDER BY created_at, id`, [o.id])).rows;
  const reservations = (await c.query<ReservationRow>(
    `SELECT v.id, v.lot_id, l.item_key, l.unit, l.label, v.quantity::text, v.state, v.expires_at::text
       FROM aurea.reservation v JOIN aurea.stock_lot l ON l.id = v.lot_id WHERE v.order_id = $1 ORDER BY l.item_key, v.created_at`, [o.id])).rows;
  const paid = add(ZERO, ...payments.filter((p) => p.kind === "DEPOSIT" && p.state === "CONFIRMED" && !p.review_reason).map((p) => dec(p.amount)));
  const outstanding = sub(dec(o.deposit_required), paid);
  return {
    id: o.id, quoteId: o.quote_id, projectId: o.project_id, projectTitle: o.project_title, revisionId: o.revision_id,
    revisionNumber: o.revision_number, state: o.state, total: money(o.total, o.currency),
    deposit: {
      required: money(o.deposit_required, o.currency), paid: money(str(paid), o.currency),
      outstanding: money(str(cmp(outstanding, ZERO) > 0 ? outstanding : ZERO), o.currency),
    },
    balance: money(str(sub(dec(o.total), paid)), o.currency),
    reservations: reservations.map((v) => ({
      id: v.id, lotId: v.lot_id, itemKey: v.item_key, lotLabel: v.label, unit: v.unit, quantity: trim(v.quantity), state: v.state,
      expiresAt: new Date(v.expires_at).toISOString(),
    })),
    payments: payments.map(toPayment),
    cancelReason: o.cancel_reason,
    createdAt: new Date(o.created_at).toISOString(), updatedAt: new Date(o.updated_at).toISOString(),
  };
}

// ---------------------------------------------------------------- stock

/**
 * Release expired HELD reservations of the given lots. Caller holds the lot row locks
 * (machines.json Reservation: expire "under lot lock").
 */
export async function sweepExpired(c: PoolClient, lotIds: string[]): Promise<number> {
  if (!lotIds.length) return 0;
  const { rows } = await c.query<{ lot_id: string; quantity: string }>(
    `UPDATE aurea.reservation SET state = 'RELEASED', updated_at = now()
      WHERE lot_id = ANY($1::uuid[]) AND state = 'HELD' AND expires_at <= now() RETURNING lot_id, quantity::text`, [lotIds]);
  for (const r of rows) await c.query("UPDATE aurea.stock_lot SET reserved = reserved - $2 WHERE id = $1", [r.lot_id, r.quantity]);
  return rows.length;
}

/**
 * Lock order for stock (every path takes it the same way, so two transactions never wait on each
 * other in a cycle): stock_lot rows first, all at once, ordered by id; reservations after.
 */
export async function lockLots(c: PoolClient, itemKeys: string[], lotIds: string[] = []): Promise<string[]> {
  return (await c.query<{ id: string }>(
    "SELECT id FROM aurea.stock_lot WHERE item_key = ANY($1::text[]) OR id = ANY($2::uuid[]) ORDER BY id FOR UPDATE", [itemKeys, lotIds])).rows.map((r) => r.id);
}

/**
 * Hold `grams` of each material for an order. Locks every lot of the needed materials (lockLots),
 * sweeps expired holds, then takes the first lot with enough available. stock_lot's CHECK
 * (reserved <= on_hand) is the last line against overselling.
 * One lot per material in hito 500 (no splitting across lots).
 */
export async function holdStock(c: PoolClient, orderId: string, needs: Map<string, string>, actor: string, hours: number) {
  const keys = [...needs.keys()].sort();
  await sweepExpired(c, await lockLots(c, keys));
  for (const itemKey of keys) {
    const qty = needs.get(itemKey)!;
    const lot = (await c.query<{ id: string }>(
      `SELECT id FROM aurea.stock_lot WHERE item_key = $1 AND unit = 'g' AND on_hand - reserved >= $2 ORDER BY created_at, id LIMIT 1`,
      [itemKey, qty])).rows[0];
    if (!lot) {
      throw new ApiError(409, "INSUFFICIENT_STOCK", [{ code: "INSUFFICIENT_STOCK", pointer: `/materials/${itemKey}`, message: `not enough ${itemKey} available (${qty} g needed)` }]);
    }
    await c.query("UPDATE aurea.stock_lot SET reserved = reserved + $2 WHERE id = $1", [lot.id, qty]);
    await c.query(
      `INSERT INTO aurea.reservation(id, lot_id, order_id, quantity, expires_at, state, created_by)
       VALUES ($1,$2,$3,$4, now() + make_interval(hours => $5), 'HELD', $6)`, [randomUUID(), lot.id, orderId, qty, hours, actor]);
  }
}

/** Release every open reservation of an order (cancel). */
export async function releaseOrderStock(c: PoolClient, orderId: string): Promise<void> {
  const lots = (await c.query<{ lot_id: string }>("SELECT DISTINCT lot_id FROM aurea.reservation WHERE order_id = $1", [orderId])).rows;
  if (lots.length) await lockLots(c, [], lots.map((l) => l.lot_id));
  const { rows } = await c.query<{ lot_id: string; quantity: string }>(
    `UPDATE aurea.reservation SET state = 'RELEASED', updated_at = now() WHERE order_id = $1 AND state IN ('HELD','ALLOCATED')
     RETURNING lot_id, quantity::text`, [orderId]);
  for (const r of rows) await c.query("UPDATE aurea.stock_lot SET reserved = reserved - $2 WHERE id = $1", [r.lot_id, r.quantity]);
}

// ---------------------------------------------------------------- events

export async function emit(c: PoolClient, type: string, aggregateId: string, version: number, correlationId: string, payload: object) {
  await c.query(
    `INSERT INTO aurea.outbox(id, event_type, schema_version, aggregate_id, aggregate_version, occurred_at, correlation_id, payload)
     VALUES ($1,$2,1,$3,$4,now(),$5,$6)`, [randomUUID(), type, aggregateId, version, correlationId, payload]);
}

export async function audit(c: PoolClient, actor: string, action: string, resourceId: string, correlationId: string, details: object = {}) {
  await c.query("INSERT INTO aurea.audit_event(id, actor, action, resource_id, correlation_id, details) VALUES ($1,$2,$3,$4,$5,$6)",
    [randomUUID(), actor, action, resourceId, correlationId, details]);
}
