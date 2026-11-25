import { Body, Controller, Get, Headers, HttpCode, Inject, NotFoundException, Optional, Param, Post, Query, Req } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { DATABASE } from "../database";
import { correlationId } from "../errors.filter";
import { RequirePermission } from "../identity/permission.decorator";
import { Public } from "../public.decorator";
import { ApiError } from "../design/api-error";
import { decodeCursor, encodeCursor, idempotent, tx, uuidParam } from "../design/repo";
import type { CommerceConfig } from "./config";
import { add, cmp, dec, str, sub, ZERO } from "./money";
import { applyEvent, newProviderId, parseEvent, sign, SIMULATED, simulatedEvents, verify } from "./payments";
import { COMMERCE_CONFIG } from "./quotes.controller";
import {
  audit, bad, emit, moneyBody, objectBody, ORDER_COLUMNS, ORDER_FROM, orderDetail, orderFilter, PAYMENT_COLUMNS, releaseOrderStock,
  scopeOf, sweepExpired, toPayment, trim, visibleOrder, type AuthedRequest, type OrderRow, type PaymentRow,
} from "./repo";

const ORDER_STATES = ["PENDING_PAYMENT", "CONFIRMED", "FULFILLING", "READY", "DELIVERED", "CANCELLED"];

function needConfig(cfg: CommerceConfig | null): CommerceConfig {
  if (!cfg) throw new ApiError(503, "PROVIDER_NOT_CONFIGURED");
  return cfg;
}

/** Orders (OpenAPI orders tag). Orders are only born from acceptQuote. */
@Controller("orders")
export class OrdersController {
  constructor(@Inject(DATABASE) private readonly pool: Pool) {}

  @Get()
  @RequirePermission("order.read")
  async list(@Req() req: AuthedRequest, @Query("state") state?: string, @Query("cursor") cursor?: string, @Query("limit") limitRaw?: string) {
    if (state !== undefined && !ORDER_STATES.includes(state)) throw bad("/state", `one of ${ORDER_STATES.join(", ")}`);
    const limit = limitRaw === undefined ? 20 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw bad("/limit", "integer 1-50");
    const after = decodeCursor(cursor) as [string, string] | null;
    const f = orderFilter(req.principal, 5);
    const { rows } = await this.pool.query<OrderRow>(
      `SELECT ${ORDER_COLUMNS} FROM ${ORDER_FROM} WHERE ${f.sql} AND ($1::text IS NULL OR o.state = $1)
         AND ($2::timestamptz IS NULL OR (o.created_at, o.id) < ($2::timestamptz, $3::uuid))
       ORDER BY o.created_at DESC, o.id DESC LIMIT $4`, [state ?? null, after?.[0] ?? null, after?.[1] ?? null, limit + 1, ...f.params]);
    const page = rows.slice(0, limit);
    return {
      items: await Promise.all(page.map((o) => orderDetail(this.pool, o))),
      nextCursor: rows.length > limit ? encodeCursor([page[page.length - 1].created_at, page[page.length - 1].id]) : null,
    };
  }

  @Get(":id")
  @RequirePermission("order.read")
  async get(@Req() req: AuthedRequest, @Param("id") id: string) {
    return orderDetail(this.pool, await visibleOrder(this.pool, req.principal, uuidParam(id, "/id")));
  }

  /**
   * cancelOrder: the customer cancels before the deposit is confirmed; the held metal is released in
   * the same transaction. A confirmed order needs compensation and a person (not in hito 500).
   */
  @Post(":id/cancel")
  @HttpCode(200)
  @RequirePermission("order.cancel")
  async cancel(@Req() req: AuthedRequest, @Param("id") idRaw: string, @Body() raw: unknown, @Headers("idempotency-key") key?: string) {
    const id = uuidParam(idRaw, "/id");
    const b = objectBody(raw, ["reason"]);
    const reason = typeof b.reason === "string" ? b.reason.trim() : "";
    if (!reason || reason.length > 2000) throw bad("/reason", "1-2000 characters");
    const p = req.principal;
    const cid = correlationId(req);
    return tx(this.pool, (c) => idempotent(c, p.subject, "cancelOrder", key, { id, ...b }, async () => {
      const o = await ownOrder(c, p.subject, id);
      if (o.state !== "PENDING_PAYMENT") {
        throw new ApiError(409, "INVALID_TRANSITION", [{ code: "INVALID_TRANSITION", pointer: "/state", message: `order is ${o.state}; cancelling it needs the jeweler (compensation)` }]);
      }
      await releaseOrderStock(c, id);
      const v = (await c.query<{ version: number }>(
        "UPDATE aurea.sales_order SET state = 'CANCELLED', cancel_reason = $2, version = version + 1, updated_at = now() WHERE id = $1 RETURNING version", [id, reason])).rows[0].version;
      await emit(c, "OrderCancelled", id, v, cid, { orderId: id, state: "CANCELLED" });
      await audit(c, p.subject, "order.cancel", id, cid);
      return orderDetail(c, (await c.query<OrderRow>(`SELECT ${ORDER_COLUMNS} FROM ${ORDER_FROM} WHERE o.id = $1`, [id])).rows[0]);
    }));
  }
}

async function ownOrder(c: PoolClient, subject: string, id: string): Promise<OrderRow> {
  const { rows } = await c.query<OrderRow>(
    `SELECT ${ORDER_COLUMNS} FROM ${ORDER_FROM} WHERE o.id = $1 AND o.customer_id = (SELECT id FROM aurea.customer WHERE subject = $2) FOR UPDATE OF o`, [id, subject]);
  if (!rows[0]) throw new NotFoundException();
  return rows[0];
}

/** Payments (OpenAPI payments tag). Only the provider's verified events confirm a payment. */
@Controller()
export class PaymentsController {
  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Optional() @Inject(COMMERCE_CONFIG) private readonly cfg: CommerceConfig | null,
  ) {}

  /**
   * createPaymentIntent: the deposit of an order, for exactly the outstanding amount. One open or
   * confirmed deposit per order (also a unique index): a second intent is refused, not duplicated.
   */
  @Post("payment-intents")
  @HttpCode(200)
  @RequirePermission("payment.create")
  async create(@Req() req: AuthedRequest, @Body() raw: unknown, @Headers("idempotency-key") key?: string) {
    const cfg = needConfig(this.cfg);
    const b = objectBody(raw, ["orderId", "kind", "amount"]);
    const orderId = uuidParam(b.orderId as string | undefined, "/orderId");
    if (b.kind !== "DEPOSIT") throw bad("/kind", "only DEPOSIT in hito 500");
    const amount = moneyBody(b.amount, "/amount");
    const p = req.principal;
    const cid = correlationId(req);
    return tx(this.pool, (c) => idempotent(c, p.subject, "createPaymentIntent", key, b, async () => {
      const o = await ownOrder(c, p.subject, orderId);
      if (o.state !== "PENDING_PAYMENT") throw new ApiError(409, "INVALID_TRANSITION", [{ code: "INVALID_TRANSITION", pointer: "/orderId", message: `order is ${o.state}` }]);
      const prior = (await c.query<PaymentRow>(
        `SELECT ${PAYMENT_COLUMNS} FROM aurea.payment WHERE order_id = $1 AND kind = 'DEPOSIT' AND state IN ('PENDING','PROCESSING','CONFIRMED','PARTIAL_REFUND','DISPUTED')`, [orderId])).rows[0];
      if (prior) {
        const code = prior.state === "PENDING" || prior.state === "PROCESSING" ? "PAYMENT_IN_PROGRESS" : "ALREADY_PAID";
        throw new ApiError(409, code, [{ code, pointer: "/orderId", message: `deposit ${prior.id} is ${prior.state}` }]);
      }
      if (amount.currency !== o.currency || cmp(dec(amount.amount), dec(o.deposit_required)) !== 0) {
        throw new ApiError(422, "AMOUNT_MISMATCH", [{ code: "AMOUNT_MISMATCH", pointer: "/amount", message: `the deposit is ${trim(o.deposit_required)} ${o.currency}` }]);
      }
      const id = randomUUID();
      try {
        await c.query("SAVEPOINT intent");
        await c.query(
          `INSERT INTO aurea.payment(id, order_id, provider, provider_id, currency, amount, state, kind, simulated, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,'PENDING','DEPOSIT',true,$7)`, [id, orderId, cfg.paymentProvider, newProviderId(), o.currency, o.deposit_required, p.subject]);
      } catch (err) {
        await c.query("ROLLBACK TO SAVEPOINT intent");
        if ((err as { code?: string }).code === "23505") throw new ApiError(409, "PAYMENT_IN_PROGRESS");
        throw err;
      }
      await emit(c, "PaymentCreated", id, 1, cid, { paymentId: id, orderId, state: "PENDING" });
      await audit(c, p.subject, "payment.create", id, cid, { orderId, simulated: true });
      return { ...toPayment((await c.query<PaymentRow>(`SELECT ${PAYMENT_COLUMNS} FROM aurea.payment WHERE id = $1`, [id])).rows[0]), checkout: { kind: "SIMULATED" } };
    }));
  }

  @Get("payments/:id")
  @RequirePermission("payment.read")
  async get(@Req() req: AuthedRequest, @Param("id") idRaw: string) {
    const id = uuidParam(idRaw, "/id");
    const pay = (await this.pool.query<PaymentRow>(`SELECT ${PAYMENT_COLUMNS} FROM aurea.payment WHERE id = $1`, [id])).rows[0];
    if (!pay) throw new NotFoundException();
    if (scopeOf(req.principal, "payment.read") !== "organization") await visibleOrder(this.pool, req.principal, pay.order_id);
    return toPayment(pay);
  }

  /**
   * Simulated checkout (local/ci/demo only): stands in for the customer completing the provider's
   * hosted page. It signs provider events with the webhook key and feeds them to the same handler as
   * POST /payments/webhooks/simulated, so the confirmation path is the real one.
   */
  @Post("payments/:id/simulate")
  @HttpCode(200)
  @RequirePermission("payment.create")
  async simulate(@Req() req: AuthedRequest, @Param("id") idRaw: string, @Body() raw: unknown, @Headers("idempotency-key") key?: string) {
    const cfg = needConfig(this.cfg);
    const id = uuidParam(idRaw, "/id");
    const b = objectBody(raw, ["outcome"]);
    if (b.outcome !== "APPROVE" && b.outcome !== "DECLINE") throw bad("/outcome", "APPROVE or DECLINE");
    const p = req.principal;
    const cid = correlationId(req);
    return tx(this.pool, (c) => idempotent(c, p.subject, "simulatePayment", key, { id, ...b }, async () => {
      const pay = (await c.query<PaymentRow>(`SELECT ${PAYMENT_COLUMNS} FROM aurea.payment WHERE id = $1`, [id])).rows[0];
      if (!pay) throw new NotFoundException();
      await ownOrder(c, p.subject, pay.order_id);
      if (pay.provider !== SIMULATED || !pay.simulated) throw new ApiError(409, "INVALID_TRANSITION");
      if (pay.state !== "PENDING" && pay.state !== "PROCESSING") throw new ApiError(409, "INVALID_TRANSITION", [{ code: "INVALID_TRANSITION", pointer: "/state", message: `payment is ${pay.state}` }]);
      for (const e of simulatedEvents(pay, b.outcome as "APPROVE" | "DECLINE")) {
        const body = Buffer.from(JSON.stringify(e));
        verify(cfg.paymentWebhookSecret, body, sign(cfg.paymentWebhookSecret, body.toString()), cfg.webhookToleranceS);
        await applyEvent(c, SIMULATED, parseEvent(body), body, cid, cfg.rules.reservationHours);
      }
      return toPayment((await c.query<PaymentRow>(`SELECT ${PAYMENT_COLUMNS} FROM aurea.payment WHERE id = $1`, [id])).rows[0]);
    }));
  }

  /** Provider webhook: no token; the HMAC signature over the raw body is the authorization. */
  @Post("payments/webhooks/:provider")
  @HttpCode(200)
  @Public()
  async webhook(@Req() req: AuthedRequest, @Param("provider") provider: string, @Headers("x-aurea-signature") signature?: string) {
    const cfg = needConfig(this.cfg);
    if (provider !== SIMULATED) throw new NotFoundException();
    const raw = req.rawBody;
    if (!raw || raw.length > 64 * 1024) throw bad("", "signed JSON body required");
    verify(cfg.paymentWebhookSecret, raw, signature, cfg.webhookToleranceS);
    const e = parseEvent(raw);
    const r = await tx(this.pool, (c) => applyEvent(c, SIMULATED, e, raw, correlationId(req), cfg.rules.reservationHours));
    return { received: true, outcome: r.outcome };
  }
}

/** Inventory (OpenAPI inventory tag): lots with available = on hand − reserved; append-only movements. */
@Controller("inventory")
export class InventoryController {
  constructor(@Inject(DATABASE) private readonly pool: Pool) {}

  @Get("lots")
  @RequirePermission("inventory.read")
  async lots(@Query("itemKey") itemKey?: string) {
    if (itemKey !== undefined && !/^[a-z0-9][a-z0-9-]{1,63}$/.test(itemKey)) throw bad("/itemKey", "material id");
    return tx(this.pool, async (c) => {
      const ids = (await c.query<{ id: string }>(
        "SELECT id FROM aurea.stock_lot WHERE ($1::text IS NULL OR item_key = $1) ORDER BY id FOR UPDATE", [itemKey ?? null])).rows.map((r) => r.id);
      await sweepExpired(c, ids);
      const { rows } = await c.query<{ id: string; item_key: string; unit: string; on_hand: string; reserved: string; label: string; demo: boolean;
        location_id: string; location_name: string; held: string; allocated: string }>(
        `SELECT l.id, l.item_key, l.unit, l.on_hand::text, l.reserved::text, l.label, l.demo, l.location_id, loc.name AS location_name,
                COALESCE(SUM(v.quantity) FILTER (WHERE v.state = 'HELD'), 0)::text AS held,
                COALESCE(SUM(v.quantity) FILTER (WHERE v.state = 'ALLOCATED'), 0)::text AS allocated
           FROM aurea.stock_lot l JOIN aurea.location loc ON loc.id = l.location_id LEFT JOIN aurea.reservation v ON v.lot_id = l.id
          WHERE l.id = ANY($1::uuid[]) GROUP BY l.id, loc.name ORDER BY l.item_key, l.created_at, l.id`, [ids]);
      return {
        items: rows.map((l) => ({
          id: l.id, itemKey: l.item_key, label: l.label, unit: l.unit, location: { id: l.location_id, name: l.location_name },
          onHand: trim(l.on_hand), reserved: trim(l.reserved), available: trim(str(sub(dec(l.on_hand), dec(l.reserved)))),
          held: trim(l.held), allocated: trim(l.allocated), demo: l.demo,
        })),
        nextCursor: null,
      };
    });
  }

  /** recordMovement: receipt or adjustment, appended to the ledger; on hand can never go below reserved. */
  @Post("movements")
  @HttpCode(200)
  @RequirePermission("inventory.move")
  async move(@Req() req: AuthedRequest, @Body() raw: unknown, @Headers("idempotency-key") key?: string) {
    const b = objectBody(raw, ["lotId", "kind", "delta", "reason", "evidenceId"]);
    const lotId = uuidParam(b.lotId as string | undefined, "/lotId");
    if (b.kind !== "RECEIPT" && b.kind !== "ADJUSTMENT") throw bad("/kind", "RECEIPT or ADJUSTMENT");
    if (typeof b.delta !== "string" || !/^-?\d+(\.\d{1,6})?$/.test(b.delta) || dec(b.delta) === 0n) throw bad("/delta", "non-zero decimal string");
    if (b.kind === "RECEIPT" && dec(b.delta) < 0n) throw bad("/delta", "a receipt adds stock");
    const reason = typeof b.reason === "string" ? b.reason.trim() : "";
    if (!reason || reason.length > 500) throw bad("/reason", "1-500 characters");
    if (b.evidenceId !== undefined) uuidParam(b.evidenceId as string, "/evidenceId");
    const p = req.principal;
    const cid = correlationId(req);
    return tx(this.pool, (c) => idempotent(c, p.subject, "recordMovement", key, b, async () => {
      const lot = (await c.query<{ on_hand: string; reserved: string }>("SELECT on_hand::text, reserved::text FROM aurea.stock_lot WHERE id = $1 FOR UPDATE", [lotId])).rows[0];
      if (!lot) throw new NotFoundException();
      await sweepExpired(c, [lotId]);
      const reserved = dec((await c.query<{ reserved: string }>("SELECT reserved::text FROM aurea.stock_lot WHERE id = $1", [lotId])).rows[0].reserved);
      const after = add(dec(lot.on_hand), dec(b.delta as string));
      if (cmp(after, reserved) < 0 || cmp(after, ZERO) < 0) {
        throw new ApiError(409, "INSUFFICIENT_STOCK", [{ code: "INSUFFICIENT_STOCK", pointer: "/delta", message: "on hand cannot go below what is reserved" }]);
      }
      const id = randomUUID();
      await c.query("UPDATE aurea.stock_lot SET on_hand = $2 WHERE id = $1", [lotId, str(after)]);
      await c.query(
        `INSERT INTO aurea.stock_movement(id, lot_id, quantity_delta, actor, reason, kind, on_hand_after) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, lotId, b.delta, p.subject, reason, b.kind, str(after)]);
      await audit(c, p.subject, "inventory.move", lotId, cid, { movementId: id, kind: b.kind });
      return { id, lotId, kind: b.kind, delta: b.delta, onHandAfter: trim(str(after)) };
    }));
  }
}

