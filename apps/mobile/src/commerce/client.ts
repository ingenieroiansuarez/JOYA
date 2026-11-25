// Commerce endpoints (OpenAPI 1.11.0) on top of Api.send. Creating calls carry an Idempotency-Key the
// caller keeps, so a retry after a lost answer returns the first result instead of acting twice.
import type { Api, Money } from "../api";
import type { WithToken } from "../design/client";

export type QuoteState = "DRAFT" | "ISSUED" | "ACCEPTED" | "EXPIRED" | "REJECTED" | "SUPERSEDED";
export interface QuoteLine { code: string; label: string; amount: Money }
export interface Quote {
  id: string; projectId: string; projectTitle: string; revisionId: string; revisionNumber: number; state: QuoteState;
  total: Money; subtotal: Money; tax: { code: string; rate: string; amount: Money }; lines: QuoteLine[];
  deposit: { rate: string; amount: Money };
  bom: { componentId: string; materialId: string; massGrams: string }[];
  pricing: { ruleVersion: string; termsVersion: string; simulated: boolean };
  digest: string; termsVersion: string | null; expiresAt: string; issuedAt: string | null; orderId: string | null;
}
export type PaymentState = "PENDING" | "PROCESSING" | "FAILED" | "CONFIRMED" | "PARTIAL_REFUND" | "REFUNDED" | "DISPUTED";
export interface Payment {
  id: string; orderId: string; kind: "DEPOSIT" | "BALANCE"; amount: Money; state: PaymentState;
  provider: { id: string; simulated: boolean }; failureCode: string | null; reviewReason: string | null;
}
export type OrderState = "PENDING_PAYMENT" | "CONFIRMED" | "FULFILLING" | "READY" | "DELIVERED" | "CANCELLED";
export interface Order {
  id: string; quoteId: string; projectTitle: string; revisionNumber: number; state: OrderState; total: Money;
  deposit: { required: Money; paid: Money; outstanding: Money }; balance: Money;
  reservations: { id: string; itemKey: string; lotLabel: string; unit: string; quantity: string; state: string; expiresAt: string }[];
  payments: Payment[]; cancelReason: string | null;
}

export class CommerceClient {
  constructor(private readonly api: Api, private readonly withToken: WithToken) {}

  private call<T>(method: string, path: string, opts: { body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
    return this.withToken((token) => this.api.send<T>(method, path, { ...opts, token }) as Promise<T>);
  }

  /** One open quote per revision: asking again returns it (a lapsed offer is closed and a new draft made). */
  requestQuote(revisionId: string, currency: string, idempotencyKey: string): Promise<Quote> {
    return this.call("POST", "/quotes", { body: { revisionId, currency }, idempotencyKey });
  }
  getQuote(id: string): Promise<Quote> {
    return this.call("GET", `/quotes/${encodeURIComponent(id)}`);
  }
  /** Accepts exactly the issued version the customer saw (digest + terms); creates the order and holds the metal. */
  acceptQuote(q: Quote, idempotencyKey: string): Promise<Order> {
    return this.call("POST", `/quotes/${encodeURIComponent(q.id)}/accept`, { body: { expectedDigest: q.digest, termsVersion: q.termsVersion }, idempotencyKey });
  }
  getOrder(id: string): Promise<Order> {
    return this.call("GET", `/orders/${encodeURIComponent(id)}`);
  }
  createDeposit(order: Order, idempotencyKey: string): Promise<Payment> {
    return this.call("POST", "/payment-intents", { body: { orderId: order.id, kind: "DEPOSIT", amount: order.deposit.outstanding }, idempotencyKey });
  }
  /** Simulated checkout only: the API signs provider events and runs them through the webhook path. */
  simulate(paymentId: string, outcome: "APPROVE" | "DECLINE", idempotencyKey: string): Promise<Payment> {
    return this.call("POST", `/payments/${encodeURIComponent(paymentId)}/simulate`, { body: { outcome }, idempotencyKey });
  }
}

/** The deposit attempt still open on an order (one at a time), if any. */
export const openDeposit = (o: Order): Payment | undefined =>
  o.payments.find((p) => p.kind === "DEPOSIT" && (p.state === "PENDING" || p.state === "PROCESSING") && !p.reviewReason);
