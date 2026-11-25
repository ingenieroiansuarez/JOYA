// Payment provider boundary (COMMERCE.md PaymentProvider). Hito 500 only has the simulated provider:
// it never moves money, but its events are signed and go through exactly the path a real
// provider's webhooks will (signature, dedup by event id, amount and currency check).
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { ApiError } from "../design/api-error";
import { sha256 } from "../design/repo";
import { cmp, dec } from "./money";
import { reserveByMaterial, type PricingSnapshot } from "./pricing";
import { audit, emit, holdStock, PAYMENT_COLUMNS, trim, type PaymentRow } from "./repo";

export const SIMULATED = "simulated";
export interface ProviderEvent {
  eventId: string;
  type: "payment.processing" | "payment.succeeded" | "payment.failed";
  providerPaymentId: string;
  amount: { amount: string; currency: string };
  failureCode?: string;
}

export const newProviderId = () => `sim_${randomBytes(12).toString("hex")}`;

export function sign(secret: string, body: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

/** Verifies `t=<unix>,v1=<hex>` over `${t}.${rawBody}`; throws 401 INVALID_SIGNATURE. */
export function verify(secret: string, raw: Buffer, header: string | undefined, toleranceS: number): void {
  const parts = Object.fromEntries((header ?? "").split(",").map((kv) => kv.trim().split("=", 2) as [string, string]));
  const t = Number(parts.t);
  const fail = () => new ApiError(401, "INVALID_SIGNATURE");
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(parts.v1 ?? "")) throw fail();
  if (Math.abs(Date.now() / 1000 - t) > toleranceS) throw fail();
  const want = createHmac("sha256", secret).update(Buffer.concat([Buffer.from(`${t}.`), raw])).digest();
  if (!timingSafeEqual(want, Buffer.from(parts.v1, "hex"))) throw fail();
}

export function parseEvent(raw: Buffer): ProviderEvent {
  let e: ProviderEvent;
  try {
    e = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new ApiError(400, "VALIDATION_FAILED");
  }
  const ok = e && typeof e.eventId === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(e.eventId)
    && ["payment.processing", "payment.succeeded", "payment.failed"].includes(e.type)
    && typeof e.providerPaymentId === "string" && e.providerPaymentId.length <= 128
    && typeof e.amount?.amount === "string" && /^\d+(\.\d{1,6})?$/.test(e.amount.amount) && /^[A-Z]{3}$/.test(e.amount?.currency ?? "")
    && (e.failureCode === undefined || /^[A-Z][A-Z0-9_]{1,63}$/.test(e.failureCode));
  if (!ok) throw new ApiError(400, "VALIDATION_FAILED");
  return e;
}

export type Outcome = "APPLIED" | "IGNORED" | "REVIEW" | "DUPLICATE";

/**
 * Applies one verified provider event in the caller's transaction. A replayed event id changes
 * nothing (payment_event primary key). Confirmation needs the exact amount and currency; a late
 * success on a cancelled order is recorded for review and never re-opens the order.
 */
export async function applyEvent(c: PoolClient, provider: string, e: ProviderEvent, raw: Buffer, cid: string, reservationHours: number): Promise<{ outcome: Outcome; paymentId: string | null }> {
  const pay = (await c.query<PaymentRow>(`SELECT ${PAYMENT_COLUMNS} FROM aurea.payment WHERE provider = $1 AND provider_id = $2 FOR UPDATE`, [provider, e.providerPaymentId])).rows[0];
  const record = async (outcome: Exclude<Outcome, "DUPLICATE">) => {
    const ins = await c.query(
      `INSERT INTO aurea.payment_event(provider, event_id, payment_id, event_type, payload_sha256, outcome) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [provider, e.eventId, pay?.id ?? null, e.type, sha256(raw), outcome]);
    return ins.rowCount === 1;
  };
  // Dedup first: the same event id is processed once, whatever its content says now.
  const seen = (await c.query("SELECT 1 FROM aurea.payment_event WHERE provider = $1 AND event_id = $2", [provider, e.eventId])).rowCount;
  if (seen) return { outcome: "DUPLICATE", paymentId: pay?.id ?? null };
  if (!pay) {
    await record("IGNORED");
    return { outcome: "IGNORED", paymentId: null };
  }
  const order = (await c.query<{ id: string; state: string; deposit_required: string; version: number }>(
    "SELECT id, state, deposit_required::text, version FROM aurea.sales_order WHERE id = $1 FOR UPDATE", [pay.order_id])).rows[0];
  const sameMoney = e.amount.currency === pay.currency && cmp(dec(e.amount.amount), dec(pay.amount)) === 0;
  const bump = async (state: string, extra = "", params: unknown[] = []) => {
    const v = (await c.query<{ version: number }>(
      `UPDATE aurea.payment SET state = $2, version = version + 1, updated_at = now() ${extra} WHERE id = $1 RETURNING version`, [pay.id, state, ...params])).rows[0].version;
    return v;
  };

  if (e.type === "payment.processing") {
    if (pay.state !== "PENDING") { await record("IGNORED"); return { outcome: "IGNORED", paymentId: pay.id }; }
    await bump("PROCESSING");
    await record("APPLIED");
    return { outcome: "APPLIED", paymentId: pay.id };
  }
  if (e.type === "payment.failed") {
    if (pay.state !== "PENDING" && pay.state !== "PROCESSING") { await record("IGNORED"); return { outcome: "IGNORED", paymentId: pay.id }; }
    const v = await bump("FAILED", ", failure_code = $3", [e.failureCode ?? "DECLINED"]);
    await emit(c, "PaymentFailed", pay.id, v, cid, { paymentId: pay.id, orderId: pay.order_id, state: "FAILED" });
    await record("APPLIED");
    return { outcome: "APPLIED", paymentId: pay.id };
  }
  // payment.succeeded
  if (pay.state !== "PENDING" && pay.state !== "PROCESSING") { await record("IGNORED"); return { outcome: "IGNORED", paymentId: pay.id }; }
  if (!sameMoney) {
    // Never confirm a different amount or currency: keep it in processing, flagged for reconciliation.
    await c.query("UPDATE aurea.payment SET review_reason = 'AMOUNT_MISMATCH', version = version + 1, updated_at = now() WHERE id = $1", [pay.id]);
    await audit(c, `provider:${provider}`, "payment.review", pay.id, cid, { reason: "AMOUNT_MISMATCH" });
    await record("REVIEW");
    return { outcome: "REVIEW", paymentId: pay.id };
  }
  const late = order.state !== "PENDING_PAYMENT";
  const v = await bump("CONFIRMED", `, confirmed_at = now()${late ? ", review_reason = $3" : ""}`, late ? [order.state === "CANCELLED" ? "ORDER_CANCELLED" : "LATE_EVENT"] : []);
  await emit(c, "PaymentConfirmed", pay.id, v, cid, { paymentId: pay.id, orderId: pay.order_id, state: "CONFIRMED" });
  if (late) {
    // A success after cancellation is money to return through an authorized refund, not a reason to re-open.
    await audit(c, `provider:${provider}`, "payment.review", pay.id, cid, { reason: order.state === "CANCELLED" ? "ORDER_CANCELLED" : "LATE_EVENT" });
    await record("REVIEW");
    return { outcome: "REVIEW", paymentId: pay.id };
  }
  const paid = (await c.query<{ paid: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS paid FROM aurea.payment WHERE order_id = $1 AND kind = 'DEPOSIT' AND state = 'CONFIRMED' AND review_reason IS NULL`, [order.id])).rows[0].paid;
  if (cmp(dec(paid), dec(order.deposit_required)) >= 0) await confirmOrder(c, order, cid, reservationHours, pay.id);
  await record("APPLIED");
  return { outcome: "APPLIED", paymentId: pay.id };
}

/**
 * Order PENDING_PAYMENT → CONFIRMED (machines.json guard: payment plan threshold) and its held metal
 * becomes ALLOCATED. A hold that expired in the meantime is taken again if the stock is still there;
 * otherwise the order waits and the payment is flagged STOCK_UNAVAILABLE for a person.
 */
async function confirmOrder(c: PoolClient, order: { id: string; version: number }, cid: string, hours: number, paymentId: string) {
  const held = (await c.query<{ id: string; lot_id: string; quantity: string }>(
    `SELECT v.id, v.lot_id, v.quantity::text FROM aurea.reservation v
      WHERE v.order_id = $1 AND v.state = 'HELD' AND v.expires_at <= now() ORDER BY v.lot_id FOR UPDATE OF v`, [order.id])).rows;
  // What the frozen quote needs, minus what is still held or allocated (an expired hold may already
  // have been swept by someone else).
  const snap = (await c.query<{ snapshot: PricingSnapshot }>(
    "SELECT q.snapshot FROM aurea.quote q JOIN aurea.sales_order o ON o.quote_id = q.id WHERE o.id = $1", [order.id])).rows[0].snapshot;
  try {
    await c.query("SAVEPOINT rehold");
    for (const h of held) {
      await c.query("SELECT id FROM aurea.stock_lot WHERE id = $1 FOR UPDATE", [h.lot_id]);
      await c.query("UPDATE aurea.reservation SET state = 'RELEASED', updated_at = now() WHERE id = $1", [h.id]);
      await c.query("UPDATE aurea.stock_lot SET reserved = reserved - $2 WHERE id = $1", [h.lot_id, h.quantity]);
    }
    const open = new Map((await c.query<{ item_key: string; qty: string }>(
      `SELECT l.item_key, SUM(v.quantity)::text AS qty FROM aurea.reservation v JOIN aurea.stock_lot l ON l.id = v.lot_id
        WHERE v.order_id = $1 AND v.state IN ('HELD','ALLOCATED') GROUP BY l.item_key`, [order.id])).rows.map((r) => [r.item_key, r.qty]));
    const missing = new Map([...reserveByMaterial(snap)].filter(([k, q]) => cmp(dec(open.get(k) ?? "0"), dec(q)) < 0));
    if (missing.size) await holdStock(c, order.id, missing, "system:confirm", hours);
    await c.query("RELEASE SAVEPOINT rehold");
  } catch (err) {
    await c.query("ROLLBACK TO SAVEPOINT rehold");
    if ((err as ApiError).code !== "INSUFFICIENT_STOCK") throw err;
    await c.query("UPDATE aurea.payment SET review_reason = 'STOCK_UNAVAILABLE', updated_at = now() WHERE id = $1", [paymentId]);
    await audit(c, "system", "order.confirm.blocked", order.id, cid, { reason: "STOCK_UNAVAILABLE" });
    return;
  }
  await c.query("UPDATE aurea.reservation SET state = 'ALLOCATED', updated_at = now() WHERE order_id = $1 AND state = 'HELD'", [order.id]);
  const v = (await c.query<{ version: number }>(
    "UPDATE aurea.sales_order SET state = 'CONFIRMED', version = version + 1, updated_at = now() WHERE id = $1 RETURNING version", [order.id])).rows[0].version;
  await emit(c, "OrderConfirmed", order.id, v, cid, { orderId: order.id, state: "CONFIRMED" });
}

/** The simulated checkout: what a customer completing the provider's hosted page would produce. */
export function simulatedEvents(pay: PaymentRow, outcome: "APPROVE" | "DECLINE"): ProviderEvent[] {
  const amount = { amount: trim(pay.amount), currency: pay.currency };
  const id = () => `evt_${randomUUID().replace(/-/g, "")}`;
  return [
    { eventId: id(), type: "payment.processing", providerPaymentId: pay.provider_id, amount },
    outcome === "APPROVE"
      ? { eventId: id(), type: "payment.succeeded", providerPaymentId: pay.provider_id, amount }
      : { eventId: id(), type: "payment.failed", providerPaymentId: pay.provider_id, amount, failureCode: "SIMULATED_DECLINE" },
  ];
}
