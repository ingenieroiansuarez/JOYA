// The gate's "accessible empty/error states": each screen state is rendered and found the way a
// screen reader finds it (role + text), against a fake API. Auth is mocked: no browser, no IdP.
import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Api, ApiError, type Product, type ProductPage } from "../src/api";
import en from "../src/messages/en.json";

jest.mock("../src/auth", () => ({
  discover: async () => ({ authorizationEndpoint: "a", tokenEndpoint: "t" }),
  refresh: async () => null, // no stored session: a guest
  isFresh: () => false,
  signIn: async () => null,
  signOut: async () => undefined,
  fetchMe: async () => ({ subject: "s", roles: ["customer"], permissions: [] }),
}));
// Imported after the mock so the provider uses it.
import { SessionProvider } from "../src/session";
import { CatalogScreen } from "../src/screens/CatalogScreen";
import { ProductScreen } from "../src/screens/ProductScreen";
import { FavoritesScreen } from "../src/screens/FavoritesScreen";

const config = { env: "ci" as const, issuer: "http://127.0.0.1:8080/realms/aurea-local", apiUrl: "http://127.0.0.1:3000" };
const summary = (id: string, name: string, extra = {}) => ({
  id, sku: `AUR-${id}`, name, category: "RING" as const, metal: "GOLD_18K_YELLOW" as const,
  price: { amount: "2850000", currency: "COP" }, available: true, customizable: true, ...extra,
});
const product: Product = {
  ...summary("p1", "Classic Ring"), summary: "Mirror-polished band.", description: "Demo piece.", collection: "Essential",
  metalWeightGrams: "4.200", stones: [{ type: "EMERALD", count: 1, totalCarats: "0.800", origin: "LAB_GROWN" }],
};

class FakeApi extends Api {
  pages: (ProductPage | ApiError)[] = [];
  detail: Product | ApiError = product;
  constructor() { super(config, "en", (async () => { throw new Error("unused"); }) as never); }
  async listProducts(): Promise<ProductPage> {
    const next = this.pages.shift();
    if (!next) throw new Error("no page queued");
    if (next instanceof ApiError) throw next;
    return next;
  }
  async getProduct(): Promise<Product> {
    if (this.detail instanceof ApiError) throw this.detail;
    return this.detail;
  }
}

const wrap = async (api: FakeApi, ui: React.ReactElement) => render(<SessionProvider config={config} apiOverride={api}>{ui}</SessionProvider>);

describe("catalog", () => {
  it("shows a spoken loading state, then cards labelled with name, metal, price and availability", async () => {
    const api = new FakeApi();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const list = api.listProducts.bind(api);
    api.listProducts = async () => { await gate; return list(); };
    api.pages.push({ items: [summary("p1", "Classic Ring"), summary("p2", "Río Hoops", { available: false })], nextCursor: null });
    await wrap(api, <CatalogScreen onOpen={() => undefined} />);
    expect(screen.getByLabelText(en.loadingCatalog)).toBeTruthy();
    release();
    expect(await screen.findByRole("button", { name: "Classic Ring, 18K yellow gold, $ 2,850,000 COP, Available" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Río Hoops, 18K yellow gold, $ 2,850,000 COP, Sold out" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: en.allCategories, selected: true })).toBeTruthy();
  });

  it("an outage is an announced error with a retry, never an empty boutique", async () => {
    const api = new FakeApi();
    api.pages.push(new ApiError("unavailable"), { items: [summary("p1", "Classic Ring")], nextCursor: null });
    await wrap(api, <CatalogScreen onOpen={() => undefined} />);
    expect((await screen.findByRole("alert")).props.children).toBe(en.errorUnavailable);
    expect(screen.queryByText(en.emptyCatalog)).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: en.retry }));
    expect(await screen.findByRole("button", { name: /^Classic Ring,/ })).toBeTruthy();
  });

  it("offline has its own message", async () => {
    const api = new FakeApi();
    api.pages.push(new ApiError("offline"));
    await wrap(api, <CatalogScreen onOpen={() => undefined} />);
    expect((await screen.findByRole("alert")).props.children).toBe(en.errorOffline);
  });

  it("an empty category says so and offers the whole boutique", async () => {
    const api = new FakeApi();
    api.pages.push({ items: [summary("p1", "Classic Ring")], nextCursor: null }, { items: [], nextCursor: null },
      { items: [summary("p1", "Classic Ring")], nextCursor: null });
    await wrap(api, <CatalogScreen onOpen={() => undefined} />);
    await screen.findByRole("button", { name: /^Classic Ring,/ });
    await fireEvent.press(screen.getByRole("tab", { name: en.category_BRACELET }));
    expect(await screen.findByText(en.emptyCategory)).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: en.showAll }));
    expect(await screen.findByRole("button", { name: /^Classic Ring,/ })).toBeTruthy();
  });
});

describe("product detail", () => {
  it("shows exact grams, carats and price, and asks a guest to sign in to save", async () => {
    await wrap(new FakeApi(), <ProductScreen id="p1" onBack={() => undefined} />);
    expect(await screen.findByRole("header", { name: "Classic Ring" })).toBeTruthy();
    expect(screen.getByText("$ 2,850,000 COP")).toBeTruthy();
    expect(screen.getByLabelText(`${en.specWeight}: 4.2 g`)).toBeTruthy();
    expect(screen.getByLabelText(`${en.specStones}: 1 × lab-grown Emerald, 0.8 ct total`)).toBeTruthy();
    expect(screen.getByRole("image", { name: "Illustration of Classic Ring, not a photograph" })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: en.saveFavorite })).toBeTruthy());
    await fireEvent.press(screen.getByRole("button", { name: en.saveFavorite }));
    expect((await screen.findByRole("alert")).props.children).toBe(en.signInToSave);
    expect(screen.getByRole("button", { name: en.signIn })).toBeTruthy();
  });

  it("a product that is gone offers the way back", async () => {
    const api = new FakeApi();
    api.detail = new ApiError("notFound", 404);
    const onBack = jest.fn();
    await wrap(api, <ProductScreen id="gone" onBack={onBack} />);
    expect((await screen.findByRole("alert")).props.children).toBe(en.productNotFound);
    await fireEvent.press(screen.getByRole("button", { name: en.backToCatalog }));
    expect(onBack).toHaveBeenCalled();
  });
});

it("favorites for a guest explain why and offer to sign in", async () => {
  await wrap(new FakeApi(), <FavoritesScreen onOpen={() => undefined} onExplore={() => undefined} />);
  expect(await screen.findByText(en.favoritesGuest)).toBeTruthy();
  expect(screen.getByRole("button", { name: en.signIn })).toBeTruthy();
});
