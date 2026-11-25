// A launch without connection, then the connection comes back: the stored account must end signed in
// (profile, favorites), not left as a guest while its designs sync.
import { expect, it, jest } from "@jest/globals";
import { act, render, waitFor } from "@testing-library/react-native";
import { Api } from "../src/api";

const mockNet = { up: false };
const mockTokens = { minted: 0 };
jest.mock("../src/auth", () => ({
  discover: async () => { if (!mockNet.up) throw new Error("network"); return { authorizationEndpoint: "a", tokenEndpoint: "t" }; },
  refresh: async () => { if (!mockNet.up) throw new Error("network"); mockTokens.minted++; return { accessToken: `tok${mockTokens.minted}`, expiresAt: Date.now() + 60_000 }; },
  isFresh: (s: { expiresAt?: number } | null) => !!s && (s.expiresAt ?? 0) > Date.now(),
  signIn: async () => null,
  signOut: async () => undefined,
  fetchMe: async () => { if (!mockNet.up) throw new Error("network"); return { subject: "s1", roles: ["customer"], permissions: [] }; },
  rememberSubject: async () => undefined,
  rememberedSubject: async () => "s1",
}));
import { SessionProvider, useSession } from "../src/session";
type SessionValue = ReturnType<typeof useSession>;

const config = { env: "ci" as const, issuer: "http://127.0.0.1:8080/realms/aurea-local", apiUrl: "http://127.0.0.1:3000" };
class FakeApi extends Api {
  constructor() { super(config, "en", (async () => { throw new Error("unused"); }) as never); }
  async listFavorites() { return { items: [], nextCursor: null }; }
}

it("after an offline launch, the first request once the connection is back signs the stored account in", async () => {
  let s!: SessionValue;
  function Probe() { s = useSession(); return null; }
  await render(<SessionProvider config={config} apiOverride={new FakeApi()}><Probe /></SessionProvider>);
  await waitFor(() => expect(s.localOwner).toBe("s1"));
  expect(s.status).toBe("guest");
  mockNet.up = true;
  await act(async () => { await s.withToken(async (t) => t); }); // e.g. the designs list asking again
  await waitFor(() => expect(s.status).toBe("signedIn"));
  expect(s.me?.subject).toBe("s1");
});

it("the identity lookup failing right after the connection returns does not leave the account as a guest", async () => {
  mockNet.up = false;
  let s!: SessionValue;
  function Probe() { s = useSession(); return null; }
  await render(<SessionProvider config={config} apiOverride={new FakeApi()}><Probe /></SessionProvider>);
  await waitFor(() => expect(s.localOwner).toBe("s1"));
  // Token endpoint reachable, the API's /me not yet (the radio comes back in steps).
  const auth = jest.requireMock("../src/auth") as { fetchMe: () => Promise<unknown> };
  const realMe = auth.fetchMe;
  let meCalls = 0;
  auth.fetchMe = async () => { meCalls++; if (meCalls === 1) throw new Error("network"); return { subject: "s1", roles: ["customer"], permissions: [] }; };
  mockNet.up = true;
  await act(async () => { await s.withToken(async (t) => t); });
  await act(async () => { await s.withToken(async (t) => t); }); // the next request tries again
  await waitFor(() => expect(s.status).toBe("signedIn"));
  auth.fetchMe = realMe;
});
