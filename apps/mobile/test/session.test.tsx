// Signed-in behaviour of the session provider with a mocked IdP: refreshes are serialized (the realm
// rotates refresh tokens with no reuse) and a failed favorites load after sign-in is recovered.
import { expect, it, jest } from "@jest/globals";
import { render, screen, waitFor } from "@testing-library/react-native";
import { useEffect } from "react";
import { Api, ApiError, type Product, type ProductPage } from "../src/api";
import en from "../src/messages/en.json";

// Tracks how many refreshes overlap; with rotation and no reuse, more than one at a time signs people out.
const mockRefreshStats = { calls: 0, inFlight: 0, maxInFlight: 0 };
async function mockRefresh() {
  mockRefreshStats.calls++;
  mockRefreshStats.inFlight++;
  mockRefreshStats.maxInFlight = Math.max(mockRefreshStats.maxInFlight, mockRefreshStats.inFlight);
  await new Promise((r) => setTimeout(r, 10));
  mockRefreshStats.inFlight--;
  return { accessToken: "tok", expiresAt: 0 };
}
jest.mock("../src/auth", () => ({
  discover: async () => ({ authorizationEndpoint: "a", tokenEndpoint: "t" }),
  refresh: () => mockRefresh(),
  isFresh: () => false, // every token request needs a refresh: worst case for concurrency
  signIn: async () => null,
  signOut: async () => undefined,
  fetchMe: async () => ({ subject: "s", roles: ["customer"], permissions: [] }),
  rememberSubject: async () => undefined,
  rememberedSubject: async () => null,
}));
import { SessionProvider, useSession } from "../src/session";
import { ProductScreen } from "../src/screens/ProductScreen";

const config = { env: "ci" as const, issuer: "http://127.0.0.1:8080/realms/aurea-local", apiUrl: "http://127.0.0.1:3000" };
const product: Product = {
  id: "p1", sku: "AUR-P1", name: "Classic Ring", category: "RING", metal: "GOLD_18K_YELLOW", price: { amount: "1", currency: "COP" },
  available: true, customizable: false, summary: "s", description: "d", collection: null, metalWeightGrams: "1.000", stones: [],
};

class FakeApi extends Api {
  favoritePages: (ProductPage | ApiError)[] = [];
  constructor() { super(config, "en", (async () => { throw new Error("unused"); }) as never); }
  async getProduct(): Promise<Product> { return product; }
  async listFavorites(): Promise<ProductPage> {
    const next = this.favoritePages.shift() ?? { items: [product], nextCursor: null };
    if (next instanceof ApiError) throw next;
    return next;
  }
}

it("concurrent token requests share one refresh", async () => {
  const api = new FakeApi();
  const seen: string[] = [];
  function Probe() {
    const { status, withToken } = useSession();
    useEffect(() => {
      if (status !== "signedIn") return;
      void Promise.all([withToken(async (t) => seen.push(t)), withToken(async (t) => seen.push(t))]);
    }, [status, withToken]);
    return null;
  }
  await render(<SessionProvider config={config} apiOverride={api}><Probe /></SessionProvider>);
  await waitFor(() => expect(seen).toHaveLength(2));
  // Launch restore, the favorites load after it and both probes ask for tokens: never two refreshes at once.
  expect(mockRefreshStats.calls).toBeGreaterThan(1);
  expect(mockRefreshStats.maxInFlight).toBe(1);
});

it("a failed favorites load after sign-in is recovered, so a saved piece offers Remove", async () => {
  const api = new FakeApi();
  api.favoritePages.push(new ApiError("unavailable")); // the load right after restore fails
  await render(<SessionProvider config={config} apiOverride={api}><ProductScreen id="p1" onBack={() => undefined} /></SessionProvider>);
  expect(await screen.findByRole("button", { name: en.removeFavorite })).toBeTruthy();
});
