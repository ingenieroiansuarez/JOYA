// Quote and order screens against an in-memory commerce API: geometry built on demand, the advisor's
// answer arriving while the customer waits, acceptance whose answer is lost (same key on retry), the
// simulated deposit, and the refusals the API can give. Auth is mocked as a signed-in customer.
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Api, ApiError } from "../src/api";
import type { Order, Payment, Quote } from "../src/commerce/client";

jest.mock("../src/auth", () => ({
  discover: async () => ({ authorizationEndpoint: "a", tokenEndpoint: "t" }),
  refresh: async () => ({ accessToken: "tok", refreshToken: "r", expiresAt: Date.now() + 3_600_000 }),
  rememberSubject: async () => undefined,
  rememberedSubject: async () => "3c1e9f50-0000-4000-8000-00000000a11c",
  isFresh: (s: { accessToken?: string } | null) => !!s?.accessToken,
  signIn: async () => null,
  signOut: async () => undefined,
  fetchMe: async () => ({ subject: "3c1e9f50-0000-4000-8000-00000000a11c", roles: ["customer"], permissions: [] }),
}));
jest.mock("expo-crypto", () => ({ randomUUID: () => require("node:crypto").randomUUID() }));
import { DesignProvider } from "../src/design/DesignContext";
import { SqliteDesignStore } from "../src/design/store";
import { sqlite } from "./designFakes";
import { SessionProvider } from "../src/session";
import { OrderScreen } from "../src/screens/OrderScreen";
import { QuoteScreen } from "../src/screens/QuoteScreen";

const config = { env: "ci" as const, issuer: "http://127.0.0.1:8080/realms/aurea-local", apiUrl: "http://127.0.0.1:3000" };
const REV = "aaaaaaaa-0000-4000-8000-000000000001";
const money = (amount: string) => ({ amount, currency: "COP" });

class CommerceApi extends Api {
  calls: { method: string; path: string; key?: string; body?: unknown }[] = [];
  hasGeometry = false;
  online = true;
  refuseRequest: string | null = null;
  refuseAccept: string | null = null;
  dropNextAccept = false;
  quote: Quote = {
    id: "q1", projectId: "p1", projectTitle: "Anillo Aurora", revisionId: REV, revisionNumber: 2, state: "DRAFT",
    total: money("5036913"), subtotal: money("4232700"), tax: { code: "TAX_DEMO", rate: "0.19", amount: money("804213") },
    lines: [{ code: "METAL:gold-18k-yellow", label: "Gold 18k yellow", amount: money("3766000") }, { code: "WORKMANSHIP", label: "Workmanship", amount: money("466700") }],
    deposit: { rate: "0.30", amount: money("1511100") }, bom: [{ componentId: "ring-base", materialId: "gold-18k-yellow", massGrams: "6.942" }],
    pricing: { ruleVersion: "demo-2026.11.0", termsVersion: "demo-terms-2026.11", simulated: true },
    digest: "d".repeat(64), termsVersion: null, expiresAt: "2026-12-02T04:59:59Z", issuedAt: null, orderId: null,
  };
  orders = new Map<string, Order>();
  acceptedByKey = new Map<string, Order>();
  payments = new Map<string, Payment>();
  constructor() { super(config, "en"); }

  issue() { this.quote = { ...this.quote, state: "ISSUED", termsVersion: "demo-terms-2026.11", digest: "e".repeat(64), issuedAt: "2026-11-25T20:00:00Z" }; }
  order(state: Order["state"] = "PENDING_PAYMENT"): Order {
    const o: Order = {
      id: "o1", quoteId: "q1", projectTitle: "Anillo Aurora", revisionNumber: 2, state, total: money("5036913"),
      deposit: { required: money("1511100"), paid: money("0"), outstanding: money("1511100") }, balance: money("5036913"),
      reservations: [{ id: "r1", itemKey: "gold-18k-yellow", lotLabel: "Gold 18k yellow (demo)", unit: "g", quantity: "7.637", state: "HELD", expiresAt: "2026-11-27T20:00:00Z" }],
      payments: [], cancelReason: null,
    };
    this.orders.set(o.id, o);
    return o;
  }

  async send<T>(method: string, path: string, opts: { body?: unknown; idempotencyKey?: string } = {}): Promise<T | undefined> {
    this.calls.push({ method, path, key: opts.idempotencyKey, body: opts.body });
    if (!this.online) throw new ApiError("offline");
    if (path.startsWith("/me/favorites")) return { items: [], nextCursor: null } as T; // the session loads them at sign-in
    const body = opts.body as Record<string, unknown>;
    let m: RegExpExecArray | null;
    if (method === "POST" && path === "/quotes") {
      if (this.refuseRequest) throw new ApiError("rejected", 422, this.refuseRequest);
      if (!this.hasGeometry) throw new ApiError("rejected", 422, "GEOMETRY_REQUIRED");
      return this.quote as T;
    }
    if (method === "POST" && path === "/geometry/jobs") { this.hasGeometry = true; return { id: "j1", state: "QUEUED" } as T; }
    if (method === "GET" && path === "/jobs/j1") return { id: "j1", state: "SUCCEEDED", errorCode: null, artifacts: [], summary: null } as T;
    if (method === "GET" && path === "/quotes/q1") return this.quote as T;
    if (method === "POST" && path === "/quotes/q1/accept") {
      if (this.refuseAccept) throw new ApiError("conflict", 409, this.refuseAccept);
      if (body.expectedDigest !== this.quote.digest || body.termsVersion !== this.quote.termsVersion) throw new ApiError("conflict", 409, "DIGEST_MISMATCH");
      const prior = this.acceptedByKey.get(opts.idempotencyKey!);
      if (prior) return prior as T;
      if (this.quote.state !== "ISSUED") throw new ApiError("conflict", 409, "INVALID_TRANSITION");
      const o = this.order();
      this.acceptedByKey.set(opts.idempotencyKey!, o);
      this.quote = { ...this.quote, state: "ACCEPTED", orderId: o.id };
      if (this.dropNextAccept) { this.dropNextAccept = false; throw new ApiError("offline"); }
      return o as T;
    }
    if (method === "GET" && (m = /^\/orders\/(\w+)$/.exec(path))) return this.orders.get(m[1]) as T;
    if (method === "POST" && path === "/payment-intents") {
      const o = this.orders.get(String(body.orderId))!;
      const p: Payment = { id: `pay${this.payments.size + 1}`, orderId: o.id, kind: "DEPOSIT", amount: body.amount as Payment["amount"], state: "PENDING",
        provider: { id: "simulated", simulated: true }, failureCode: null, reviewReason: null };
      this.payments.set(p.id, p);
      o.payments.push(p);
      return p as T;
    }
    if (method === "POST" && (m = /^\/payments\/(\w+)\/simulate$/.exec(path))) {
      const p = this.payments.get(m[1])!;
      const o = this.orders.get(p.orderId)!;
      if (body.outcome === "APPROVE") {
        p.state = "CONFIRMED";
        Object.assign(o, { state: "CONFIRMED", deposit: { ...o.deposit, paid: p.amount, outstanding: money("0") }, balance: money("3525813") });
        o.reservations = o.reservations.map((v) => ({ ...v, state: "ALLOCATED" }));
      } else { p.state = "FAILED"; p.failureCode = "SIMULATED_DECLINE"; }
      return p as T;
    }
    throw new ApiError("notFound", 404);
  }
}

async function show(api: CommerceApi, ui: React.ReactElement) {
  return render(
    <SessionProvider config={config} apiOverride={api}>
      <DesignProvider openStore={(owner) => SqliteDesignStore.open(sqlite(), owner)}>{ui}</DesignProvider>
    </SessionProvider>,
  );
}

let api: CommerceApi;
beforeEach(() => { api = new CommerceApi(); });

describe("quote", () => {
  it("builds the geometry when missing, waits for the advisor, then accepts the exact issued version", async () => {
    const onOrder = jest.fn();
    await show(api, <QuoteScreen revisionId={REV} onBack={() => undefined} onOrder={onOrder} pollMs={30} />);
    expect(await screen.findByText("An advisor is reviewing your price")).toBeTruthy();
    expect(api.calls.filter((c) => !c.path.startsWith("/me/")).map((c) => `${c.method} ${c.path}`).slice(0, 4)).toEqual(["POST /quotes", "POST /geometry/jobs", "GET /jobs/j1", "POST /quotes"]);
    expect(screen.getByText("Demo prices: not real prices.")).toBeTruthy();
    expect(screen.getByLabelText("Total: $ 5,036,913 COP")).toBeTruthy();
    expect(screen.queryByText("Accept and reserve the metal")).toBeNull();

    api.issue(); // the advisor issues it in the web panel
    expect(await screen.findByText("Your price is ready")).toBeTruthy();
    expect(screen.getByText("Valid until December 1, 2026.")).toBeTruthy();
    fireEvent.press(screen.getByText("Accept and reserve the metal"));
    await waitFor(() => expect(onOrder).toHaveBeenCalledWith("o1"));
    const accept = api.calls.find((c) => c.path === "/quotes/q1/accept")!;
    expect(accept.body).toEqual({ expectedDigest: "e".repeat(64), termsVersion: "demo-terms-2026.11" });
  });

  it("a lost acceptance answer is retried with the same key and makes one order", async () => {
    const onOrder = jest.fn();
    api.hasGeometry = true;
    api.issue();
    api.dropNextAccept = true;
    await show(api, <QuoteScreen revisionId={REV} onBack={() => undefined} onOrder={onOrder} pollMs={30} />);
    fireEvent.press(await screen.findByText("Accept and reserve the metal"));
    expect(await screen.findByText("You're offline. Check your connection and try again.")).toBeTruthy();
    // The screen still shows the version the customer accepted; pressing again replays it.
    api.quote = { ...api.quote, state: "ISSUED" };
    fireEvent.press(screen.getByText("Accept and reserve the metal"));
    await waitFor(() => expect(onOrder).toHaveBeenCalledWith("o1"));
    const keys = api.calls.filter((c) => c.path === "/quotes/q1/accept").map((c) => c.key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(api.orders.size).toBe(1);
  });

  it("explains a design that cannot be made", async () => {
    api.refuseRequest = "DFM_BLOCKED";
    await show(api, <QuoteScreen revisionId={REV} onBack={() => undefined} onOrder={() => undefined} pollMs={30} />);
    expect(await screen.findByText(/cannot be made as it is/)).toBeTruthy();
  });

  it("says when there is not enough metal to accept", async () => {
    api.hasGeometry = true;
    api.issue();
    api.refuseAccept = "INSUFFICIENT_STOCK";
    await show(api, <QuoteScreen revisionId={REV} onBack={() => undefined} onOrder={() => undefined} pollMs={30} />);
    fireEvent.press(await screen.findByText("Accept and reserve the metal"));
    expect(await screen.findByText(/not enough metal for your piece/)).toBeTruthy();
  });

  it("offline: says so and retries on request", async () => {
    api.online = false;
    await show(api, <QuoteScreen revisionId={REV} onBack={() => undefined} onOrder={() => undefined} pollMs={30} />);
    expect(await screen.findByText("You're offline. Check your connection and try again.")).toBeTruthy();
    api.online = true;
    api.hasGeometry = true;
    fireEvent.press(screen.getByText("Retry"));
    expect(await screen.findByText("An advisor is reviewing your price")).toBeTruthy();
  });
});

describe("order", () => {
  it("pays the simulated deposit once and shows the order confirmed with the metal allocated", async () => {
    api.order();
    await show(api, <OrderScreen id="o1" onBack={() => undefined} pollMs={30} />);
    await waitFor(() => expect(api.calls.some((c) => c.path === "/orders/o1")).toBe(true));
    expect(await screen.findByText("Waiting for the deposit")).toBeTruthy();
    expect(screen.getByText("Simulated payment: no real money is charged.")).toBeTruthy();
    expect(screen.getByText("Gold 18k yellow (demo): 7.637 g · held")).toBeTruthy();
    fireEvent.press(screen.getByText("Pay deposit of $ 1,511,100 COP (simulated)"));
    expect(await screen.findByText("Order confirmed")).toBeTruthy();
    expect(screen.getByText("Gold 18k yellow (demo): 7.637 g · allocated to your piece")).toBeTruthy();
    expect(screen.getByLabelText("Balance: $ 3,525,813 COP")).toBeTruthy();
    expect(api.calls.filter((c) => c.path === "/payment-intents")).toHaveLength(1);
    expect(api.calls.find((c) => c.path === "/payment-intents")!.body).toEqual({ orderId: "o1", kind: "DEPOSIT", amount: money("1511100") });
    expect(screen.queryByText(/Pay deposit/)).toBeNull();
  });

  it("an open deposit attempt is finished instead of starting a second one", async () => {
    const o = api.order();
    const open: Payment = { id: "pay9", orderId: "o1", kind: "DEPOSIT", amount: money("1511100"), state: "PROCESSING", provider: { id: "simulated", simulated: true }, failureCode: null, reviewReason: null };
    o.payments.push(open);
    api.payments.set(open.id, open);
    await show(api, <OrderScreen id="o1" onBack={() => undefined} pollMs={30} />);
    fireEvent.press(await screen.findByText("Pay deposit of $ 1,511,100 COP (simulated)"));
    expect(await screen.findByText("Order confirmed")).toBeTruthy();
    expect(api.calls.filter((c) => c.path === "/payment-intents")).toHaveLength(0);
    expect(api.calls.some((c) => c.path === "/payments/pay9/simulate")).toBe(true);
  });

  it("a payment under review hides the pay button and says so", async () => {
    const o = api.order();
    o.payments.push({ id: "pay1", orderId: "o1", kind: "DEPOSIT", amount: money("1"), state: "PENDING", provider: { id: "simulated", simulated: true }, failureCode: null, reviewReason: "AMOUNT_MISMATCH" });
    await show(api, <OrderScreen id="o1" onBack={() => undefined} pollMs={30} />);
    expect(await screen.findByText("Your payment is under review. An advisor will contact you.")).toBeTruthy();
    expect(screen.queryByText(/Pay deposit/)).toBeNull();
  });
});
