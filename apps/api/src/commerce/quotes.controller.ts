import { Body, Controller, Get, Headers, HttpCode, Inject, NotFoundException, Optional, Param, Post, Query, Req } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { DesignDocument } from "@aurea/design";
import { DATABASE } from "../database";
import { correlationId } from "../errors.filter";
import { RequirePermission } from "../identity/permission.decorator";
import { ApiError } from "../design/api-error";
import { canonicalSha, decodeCursor, encodeCursor, ensureCustomer, idempotent, ownedProject, revision, tx, uuidParam } from "../design/repo";
import type { CommerceConfig } from "./config";
import { cmp, dec } from "./money";
import { priceRevision, PricingError, reserveByMaterial, type GeometryEvidence, type PricingSnapshot } from "./pricing";
import {
  audit, bad, emit, has, holdStock, localeOf, moneyBody, objectBody, ORDER_COLUMNS, ORDER_FROM, orderDetail, QUOTE_COLUMNS, QUOTE_FROM,
  quoteFilter, toQuote, visibleQuote, type AuthedRequest, type OrderRow, type QuoteRow,
} from "./repo";

export const COMMERCE_CONFIG = Symbol("COMMERCE_CONFIG");
const STATES = ["DRAFT", "ISSUED", "ACCEPTED", "EXPIRED", "REJECTED", "SUPERSEDED"];

/** A succeeded job whose resulting design is exactly this revision (ignoring the revision counter). */
export async function geometryFor(c: Pool | PoolClient, projectId: string, rev: { id: string; document: DesignDocument }): Promise<GeometryEvidence | null> {
  const want = canonicalSha({ ...rev.document, revision: 0 });
  const { rows } = await c.query<{ id: string; kind: string; revision_id: string; summary: { document: DesignDocument; engineVersion: string; dfmState: string; components: GeometryEvidence["components"] } }>(
    `SELECT id, kind, revision_id, summary FROM aurea.job WHERE project_id = $1 AND state = 'SUCCEEDED' AND summary IS NOT NULL
      ORDER BY (kind = 'GEOMETRY' AND revision_id = $2) DESC, updated_at DESC LIMIT 200`, [projectId, rev.id]);
  const job = rows.find((j) => canonicalSha({ ...j.summary.document, revision: 0 }) === want);
  if (!job) return null;
  return { jobId: job.id, engineVersion: job.summary.engineVersion, dfmState: job.summary.dfmState, components: job.summary.components };
}

const pricingError = (e: PricingError) => new ApiError(422, "INVARIANT_VIOLATED", [{ code: e.code, pointer: e.pointer, message: e.code.toLowerCase().replace(/_/g, " ") }]);

/** Quotes (OpenAPI quotes tag). Prices are computed here from a fixed revision, never by a client. */
@Controller("quotes")
export class QuotesController {
  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Optional() @Inject(COMMERCE_CONFIG) private readonly cfg: CommerceConfig | null,
  ) {}

  private config(): CommerceConfig {
    if (!this.cfg) throw new ApiError(503, "PROVIDER_NOT_CONFIGURED");
    return this.cfg;
  }

  private async price(c: PoolClient, projectId: string, revisionId: string): Promise<PricingSnapshot> {
    const rev = await revision(c, projectId, revisionId);
    const geo = await geometryFor(c, projectId, rev);
    if (!geo) {
      throw new ApiError(422, "GEOMETRY_REQUIRED", [{ code: "GEOMETRY_REQUIRED", pointer: "/revisionId", message: "no succeeded geometry for this revision; generate it first" }]);
    }
    if (geo.dfmState === "FAIL" || geo.dfmState === "BLOCK") {
      throw new ApiError(422, "DFM_BLOCKED", [{ code: "DFM_BLOCKED", pointer: "/revisionId", message: `DFM ${geo.dfmState}: not quotable` }]);
    }
    try {
      return priceRevision(this.config().rules, rev, geo);
    } catch (e) {
      if (e instanceof PricingError) throw pricingError(e);
      throw e;
    }
  }

  /** requestQuote: the customer asks for a quote of one of their revisions; the server prices it (DRAFT). */
  @Post()
  @HttpCode(200)
  @RequirePermission("quote.request")
  async request(@Req() req: AuthedRequest, @Body() raw: unknown, @Headers("idempotency-key") key?: string) {
    const cfg = this.config();
    const b = objectBody(raw, ["revisionId", "currency"]);
    const revisionId = uuidParam(b.revisionId as string | undefined, "/revisionId");
    if (b.currency !== cfg.rules.currency) throw bad("/currency", `only ${cfg.rules.currency} is enabled`);
    const p = req.principal;
    const locale = localeOf(req.header("accept-language"));
    const cid = correlationId(req);
    return tx(this.pool, (c) => idempotent(c, p.subject, "requestQuote", key, b, async () => {
      const { rows } = await c.query<{ project_id: string }>(
        `SELECT r.project_id FROM aurea.revision r JOIN aurea.project pr ON pr.id = r.project_id JOIN aurea.customer cu ON cu.id = pr.owner_id
          WHERE r.id = $1 AND cu.subject = $2`, [revisionId, p.subject]);
      if (!rows[0]) throw new NotFoundException();
      const project = await ownedProject(c, p.subject, rows[0].project_id);
      // One open quote per revision: asking again returns it.
      const open = (await c.query<{ id: string }>("SELECT id FROM aurea.quote WHERE revision_id = $1 AND state IN ('DRAFT','ISSUED')", [revisionId])).rows[0];
      if (open) return toQuote(await visibleQuote(c, p, open.id), locale, false);
      const snapshot = await this.price(c, project.id, revisionId);
      const customerId = await ensureCustomer(c, p.subject);
      const id = randomUUID();
      const digest = canonicalSha(snapshot);
      await c.query(
        `INSERT INTO aurea.quote(id, revision_id, project_id, customer_id, requested_by, currency, amount, deposit_amount, snapshot, digest, draft_digest, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10, now() + make_interval(days => $11))`,
        [id, revisionId, project.id, customerId, p.subject, snapshot.currency, snapshot.total, snapshot.deposit.amount, snapshot, digest, cfg.rules.quoteValidityDays]);
      await emit(c, "QuoteRequested", id, 1, cid, { quoteId: id, revisionId, state: "DRAFT" });
      return toQuote(await visibleQuote(c, p, id), locale, false);
    }));
  }

  /** listQuotes: customers see theirs; advisors the DRAFT queue and the quotes they issued. */
  @Get()
  @RequirePermission("quote.read")
  async list(@Req() req: AuthedRequest, @Query("state") state?: string, @Query("cursor") cursor?: string, @Query("limit") limitRaw?: string) {
    if (state !== undefined && !STATES.includes(state)) throw bad("/state", `one of ${STATES.join(", ")}`);
    const limit = limitRaw === undefined ? 20 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw bad("/limit", "integer 1-50");
    const after = decodeCursor(cursor) as [string, string] | null;
    const p = req.principal;
    const f = quoteFilter(p, "q", 5);
    const { rows } = await this.pool.query<QuoteRow>(
      `SELECT ${QUOTE_COLUMNS} FROM ${QUOTE_FROM} WHERE ${f.sql}
         AND ($1::text IS NULL OR q.state = $1 OR ($1 = 'EXPIRED' AND q.state = 'ISSUED' AND q.expires_at <= now()))
         AND ($2::timestamptz IS NULL OR (q.created_at, q.id) < ($2::timestamptz, $3::uuid))
       ORDER BY q.created_at DESC, q.id DESC LIMIT $4`,
      [state ?? null, after?.[0] ?? null, after?.[1] ?? null, limit + 1, ...f.params]);
    const page = rows.slice(0, limit);
    const locale = localeOf(req.header("accept-language"));
    const internal = has(p, "pricing.internal");
    return {
      items: page.map((r) => toQuote(r, locale, internal)),
      nextCursor: rows.length > limit ? encodeCursor([page[page.length - 1].created_at, page[page.length - 1].id]) : null,
    };
  }

  @Get(":id")
  @RequirePermission("quote.read")
  async get(@Req() req: AuthedRequest, @Param("id") id: string) {
    const r = await visibleQuote(this.pool, req.principal, uuidParam(id, "/id"));
    return toQuote(r, localeOf(req.header("accept-language")), has(req.principal, "pricing.internal"));
  }

  /**
   * issueQuote: an advisor freezes the DRAFT they reviewed (expectedDigest + total). The server
   * re-prices first; if the rules moved, the draft is re-priced and the advisor must review again.
   */
  @Post(":id/issue")
  @HttpCode(200)
  @RequirePermission("quote.issue")
  async issue(@Req() req: AuthedRequest, @Param("id") idRaw: string, @Body() raw: unknown, @Headers("idempotency-key") key?: string) {
    const cfg = this.config();
    const id = uuidParam(idRaw, "/id");
    const b = objectBody(raw, ["expectedDigest", "expiresAt", "total", "termsVersion"]);
    if (typeof b.expectedDigest !== "string" || !/^[0-9a-f]{64}$/.test(b.expectedDigest)) throw bad("/expectedDigest", "SHA-256 hex");
    const total = moneyBody(b.total, "/total");
    if (typeof b.termsVersion !== "string") throw bad("/termsVersion", "required");
    const expires = typeof b.expiresAt === "string" ? new Date(b.expiresAt) : new Date(NaN);
    if (Number.isNaN(expires.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(String(b.expiresAt))) throw bad("/expiresAt", "RFC 3339 date-time");
    const p = req.principal;
    const locale = localeOf(req.header("accept-language"));
    const cid = correlationId(req);
    const out = await tx(this.pool, (c) => idempotent(c, p.subject, "issueQuote", key, { id, ...b }, async () => {
      const q = await visibleQuote(c, p, id, true);
      if (q.state !== "DRAFT") throw new ApiError(409, "INVALID_TRANSITION", [{ code: "INVALID_TRANSITION", pointer: "/state", message: `quote is ${q.state}` }]);
      if (q.requested_by === p.subject) throw new ApiError(403, "SEGREGATION_REQUIRED", [{ code: "SEGREGATION_REQUIRED", pointer: "", message: "the requester cannot issue their own quote" }]);
      if (b.expectedDigest !== q.draft_digest) throw new ApiError(409, "DIGEST_MISMATCH");
      if (b.termsVersion !== cfg.rules.termsVersion) throw bad("/termsVersion", `current terms are ${cfg.rules.termsVersion}`);
      const maxMs = cfg.rules.quoteValidityDays * 86_400_000;
      if (expires.getTime() <= Date.now() + 60_000 || expires.getTime() > Date.now() + maxMs) throw bad("/expiresAt", `between now and ${cfg.rules.quoteValidityDays} days`);
      const fresh = await this.price(c, q.project_id, q.revision_id);
      const freshDigest = canonicalSha(fresh);
      if (freshDigest !== q.draft_digest) {
        // Rules or geometry changed since the advisor looked: re-price the draft and ask for review.
        await c.query(`UPDATE aurea.quote SET snapshot = $2, digest = $3, draft_digest = $3, amount = $4, deposit_amount = $5, version = version + 1, updated_at = now() WHERE id = $1`,
          [id, fresh, freshDigest, fresh.total, fresh.deposit.amount]);
        return { repriced: true };
      }
      if (total.currency !== q.currency || cmp(dec(total.amount), dec(q.amount)) !== 0) throw new ApiError(409, "DIGEST_MISMATCH", [{ code: "DIGEST_MISMATCH", pointer: "/total", message: "total differs from the draft" }]);
      const frozen = { ...q.snapshot, terms: { termsVersion: cfg.rules.termsVersion, expiresAt: expires.toISOString() } };
      const digest = canonicalSha(frozen);
      // Issuing supersedes the other ISSUED quotes of the project (an older revision's offer).
      const sup = await c.query<{ id: string; version: number }>(
        `UPDATE aurea.quote SET state = 'SUPERSEDED', version = version + 1, updated_at = now() WHERE project_id = $1 AND state = 'ISSUED' AND id <> $2 RETURNING id, version`, [q.project_id, id]);
      for (const s of sup.rows) await emit(c, "QuoteSuperseded", s.id, s.version, cid, { quoteId: s.id, supersededBy: id, state: "SUPERSEDED" });
      const v = (await c.query<{ version: number }>(
        `UPDATE aurea.quote SET state = 'ISSUED', snapshot = $2, digest = $3, expires_at = $4, terms_version = $5, issued_by = $6, issued_at = now(),
                version = version + 1, updated_at = now() WHERE id = $1 RETURNING version`,
        [id, frozen, digest, expires.toISOString(), cfg.rules.termsVersion, p.subject])).rows[0].version;
      await emit(c, "QuoteIssued", id, v, cid, { quoteId: id, state: "ISSUED", digest });
      await audit(c, p.subject, "quote.issue", id, cid, { digest });
      return toQuote(await visibleQuote(c, p, id), locale, has(p, "pricing.internal"));
    }));
    if ((out as { repriced?: boolean }).repriced) {
      throw new ApiError(409, "PRICE_CHANGED", [{ code: "PRICE_CHANGED", pointer: "/expectedDigest", message: "the draft was re-priced with the current rules; review it again" }]);
    }
    return out;
  }

  /**
   * acceptQuote: the owner accepts exactly the issued version (digest + terms). In one transaction:
   * the quote is ACCEPTED, the order is created and the metal is held. No stock → nothing changes.
   */
  @Post(":id/accept")
  @HttpCode(200)
  @RequirePermission("quote.accept")
  async accept(@Req() req: AuthedRequest, @Param("id") idRaw: string, @Body() raw: unknown, @Headers("idempotency-key") key?: string) {
    const cfg = this.config();
    const id = uuidParam(idRaw, "/id");
    const b = objectBody(raw, ["expectedDigest", "termsVersion"]);
    if (typeof b.expectedDigest !== "string") throw bad("/expectedDigest", "required");
    if (typeof b.termsVersion !== "string") throw bad("/termsVersion", "required");
    const p = req.principal;
    const cid = correlationId(req);
    const out = await tx(this.pool, (c) => idempotent(c, p.subject, "acceptQuote", key, { id, ...b }, async () => {
      const q = await this.ownQuote(c, p.subject, id);
      if (q.state === "ISSUED" && q.expired) {
        await this.expire(c, q, cid);
        return { expired: true };
      }
      if (q.state !== "ISSUED") throw new ApiError(409, "INVALID_TRANSITION", [{ code: "INVALID_TRANSITION", pointer: "/state", message: `quote is ${q.state}` }]);
      if (b.expectedDigest !== q.digest || b.termsVersion !== q.terms_version) throw new ApiError(409, "DIGEST_MISMATCH");
      const orderId = randomUUID();
      await c.query(
        `INSERT INTO aurea.sales_order(id, quote_id, customer_id, currency, total, deposit_required, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [orderId, id, q.customer_id, q.currency, q.amount, q.deposit_amount, p.subject]);
      await holdStock(c, orderId, reserveByMaterial(q.snapshot), p.subject, cfg.rules.reservationHours);
      const v = (await c.query<{ version: number }>(
        "UPDATE aurea.quote SET state = 'ACCEPTED', accepted_at = now(), version = version + 1, updated_at = now() WHERE id = $1 RETURNING version", [id])).rows[0].version;
      await emit(c, "QuoteAccepted", id, v, cid, { quoteId: id, orderId, digest: q.digest, state: "ACCEPTED" });
      await emit(c, "OrderCreated", orderId, 1, cid, { orderId, quoteId: id, state: "PENDING_PAYMENT" });
      await audit(c, p.subject, "quote.accept", id, cid, { orderId, digest: q.digest });
      if (dec(q.deposit_amount) === 0n) {
        // No deposit required by the rules: the order is confirmed at once and the metal allocated.
        await c.query("UPDATE aurea.reservation SET state = 'ALLOCATED', updated_at = now() WHERE order_id = $1 AND state = 'HELD'", [orderId]);
        await c.query("UPDATE aurea.sales_order SET state = 'CONFIRMED', version = 2, updated_at = now() WHERE id = $1", [orderId]);
        await emit(c, "OrderConfirmed", orderId, 2, cid, { orderId, state: "CONFIRMED" });
      }
      const o = (await c.query<OrderRow>(`SELECT ${ORDER_COLUMNS} FROM ${ORDER_FROM} WHERE o.id = $1`, [orderId])).rows[0];
      return orderDetail(c, o);
    }));
    if ((out as { expired?: boolean }).expired) throw new ApiError(409, "QUOTE_EXPIRED");
    return out;
  }

  /** rejectQuote: the owner declines the issued version they saw. */
  @Post(":id/reject")
  @HttpCode(200)
  @RequirePermission("quote.accept")
  async reject(@Req() req: AuthedRequest, @Param("id") idRaw: string, @Body() raw: unknown, @Headers("idempotency-key") key?: string) {
    const id = uuidParam(idRaw, "/id");
    const b = objectBody(raw, ["expectedDigest", "reason"]);
    if (typeof b.expectedDigest !== "string") throw bad("/expectedDigest", "required");
    const reason = typeof b.reason === "string" ? b.reason.trim() : "";
    if (!reason || reason.length > 2000) throw bad("/reason", "1-2000 characters");
    const p = req.principal;
    const cid = correlationId(req);
    return tx(this.pool, (c) => idempotent(c, p.subject, "rejectQuote", key, { id, ...b }, async () => {
      const q = await this.ownQuote(c, p.subject, id);
      if (q.state !== "ISSUED" || q.expired) throw new ApiError(409, "INVALID_TRANSITION", [{ code: "INVALID_TRANSITION", pointer: "/state", message: `quote is ${q.expired ? "EXPIRED" : q.state}` }]);
      if (b.expectedDigest !== q.digest) throw new ApiError(409, "DIGEST_MISMATCH");
      const v = (await c.query<{ version: number }>(
        "UPDATE aurea.quote SET state = 'REJECTED', decision_reason = $2, version = version + 1, updated_at = now() WHERE id = $1 RETURNING version", [id, reason])).rows[0].version;
      await emit(c, "QuoteRejected", id, v, cid, { quoteId: id, state: "REJECTED" });
      return toQuote(await visibleQuote(c, p, id), localeOf(req.header("accept-language")), false);
    }));
  }

  /** Scope `own` for decisions: only the customer the quote belongs to (staff roles do not widen it). */
  private async ownQuote(c: PoolClient, subject: string, id: string): Promise<QuoteRow> {
    const { rows } = await c.query<QuoteRow>(
      `SELECT ${QUOTE_COLUMNS} FROM ${QUOTE_FROM} WHERE q.id = $1 AND q.customer_id = (SELECT id FROM aurea.customer WHERE subject = $2) FOR UPDATE OF q`, [id, subject]);
    if (!rows[0]) throw new NotFoundException();
    return rows[0];
  }

  private async expire(c: PoolClient, q: QuoteRow, cid: string) {
    const v = (await c.query<{ version: number }>(
      "UPDATE aurea.quote SET state = 'EXPIRED', version = version + 1, updated_at = now() WHERE id = $1 RETURNING version", [q.id])).rows[0].version;
    await emit(c, "QuoteExpired", q.id, v, cid, { quoteId: q.id, state: "EXPIRED" });
  }
}
