import { describe, expect, it } from "@jest/globals";
import { Api, ApiError, kindFor } from "../src/api";
import { formatDecimal, formatMoney } from "../src/format";
import { canGoBack, currentRoute, initialNav, navReducer } from "../src/nav";
import { mergePage } from "../src/paged";
import en from "../src/messages/en.json";
import es from "../src/messages/es.json";

const config = { env: "ci" as const, issuer: "http://127.0.0.1:8080/realms/aurea-local", apiUrl: "http://127.0.0.1:3000" };

describe("money and weights are formatted as text, never as floats", () => {
  it("groups COP the Colombian way and drops a zero fraction", () => {
    expect(formatMoney("2850000", "COP", "es")).toBe("$ 2.850.000 COP");
    expect(formatMoney("2850000.000000", "COP", "es")).toBe("$ 2.850.000 COP");
    expect(formatMoney("2850000", "COP", "en")).toBe("$ 2,850,000 COP");
  });
  it("keeps exact cents beyond float precision", () => {
    expect(formatMoney("12345678901234.1", "COP", "es")).toBe("$ 12.345.678.901.234,10 COP");
    expect(formatMoney("0.1", "USD", "en")).toBe("$ 0.10 USD");
  });
  it("shows grams and carats with their unit, unrounded", () => {
    expect(formatDecimal("4.200", "g", "es")).toBe("4,2 g");
    expect(formatDecimal("0.250", "ct", "en")).toBe("0.25 ct");
    expect(formatDecimal("12", "g", "es")).toBe("12 g");
  });
});

describe("navigation", () => {
  it("opens a product inside the current tab and back returns to the list", () => {
    const opened = navReducer(initialNav, { type: "push", route: { name: "product", id: "p1" } });
    expect(currentRoute(opened)).toEqual({ name: "product", id: "p1" });
    const back = navReducer(opened, { type: "back" });
    expect(currentRoute(back)).toEqual({ name: "catalog" });
    expect(canGoBack(back)).toBe(false); // Android may close the app now
  });
  it("each tab keeps its own stack; back from another tab goes to the boutique", () => {
    let s = navReducer(initialNav, { type: "push", route: { name: "product", id: "p1" } });
    s = navReducer(s, { type: "tab", tab: "favorites" });
    expect(currentRoute(s)).toEqual({ name: "favorites" });
    s = navReducer(s, { type: "back" });
    expect(s.tab).toBe("boutique");
    expect(currentRoute(s)).toEqual({ name: "product", id: "p1" });
  });
  it("re-tapping the current tab returns it to its root", () => {
    const s = navReducer(navReducer(initialNav, { type: "push", route: { name: "product", id: "p1" } }), { type: "tab", tab: "boutique" });
    expect(currentRoute(s)).toEqual({ name: "catalog" });
  });
});

describe("API client", () => {
  const fake = (status: number, body?: unknown) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const impl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(body === undefined ? null : JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { calls, impl };
  };

  it("asks for the device language, a page size and the category", async () => {
    const f = fake(200, { items: [], nextCursor: null });
    await new Api(config, "en", f.impl).listProducts({ category: "RING", cursor: "abc" });
    expect(f.calls[0].url).toBe("http://127.0.0.1:3000/v1/catalog/products?limit=20&cursor=abc&category=RING");
    expect((f.calls[0].init.headers as Record<string, string>)["accept-language"]).toBe("en");
    expect((f.calls[0].init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("sends the bearer token only to favorites", async () => {
    const f = fake(204);
    await new Api(config, "es", f.impl).setFavorite("tok", "p1", true);
    await new Api(config, "es", f.impl).setFavorite("tok", "p1", false);
    expect(f.calls.map((c) => c.init.method)).toEqual(["PUT", "DELETE"]);
    expect((f.calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("turns failures into kinds the UI can explain", async () => {
    await expect(new Api(config, "es", fake(503).impl).listProducts()).rejects.toMatchObject({ kind: "unavailable" });
    await expect(new Api(config, "es", fake(404).impl).getProduct("x")).rejects.toMatchObject({ kind: "notFound" });
    const offline = (async () => { throw new TypeError("Network request failed"); }) as unknown as typeof fetch;
    await expect(new Api(config, "es", offline).listProducts()).rejects.toEqual(new ApiError("offline"));
    expect(kindFor(401)).toBe("unauthenticated");
    expect(kindFor(500)).toBe("unexpected");
  });
});

it("merging a page never duplicates a product", () => {
  const p = (id: string) => ({ id } as never);
  expect(mergePage([p("a"), p("b")], { items: [p("b"), p("c")], nextCursor: null }).map((x: { id: string }) => x.id)).toEqual(["a", "b", "c"]);
});

it("Spanish and English have the same keys and placeholders", () => {
  expect(Object.keys(en).sort()).toEqual(Object.keys(es).sort());
  const vars = (m: string) => (m.match(/\{\w+\}/g) ?? []).sort();
  for (const k of Object.keys(es) as (keyof typeof es)[]) expect(vars(en[k])).toEqual(vars(es[k]));
});
