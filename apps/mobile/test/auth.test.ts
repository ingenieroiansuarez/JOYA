import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, jest } from "@jest/globals";

// jest-expo stubs the native crypto module; PKCE must be exercised with real randomness and SHA-256.
jest.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  CryptoEncoding: { BASE64: "base64", HEX: "hex" },
  getRandomValues: (a: Uint8Array) => require("node:crypto").getRandomValues(a),
  digestStringAsync: async (_alg: string, data: string, opts: { encoding: "base64" | "hex" }) =>
    require("node:crypto").createHash("sha256").update(data).digest(opts.encoding),
}));
import { buildAuthRequest } from "../src/auth";
import { CLIENT_ID, ConfigError, loadConfig, REDIRECT_URI } from "../src/config";
import en from "../src/messages/en.json";
import es from "../src/messages/es.json";

const realm = JSON.parse(readFileSync(join(__dirname, "../../../infra/keycloak/realm-aurea-local.json"), "utf8"));
const mobile = realm.clients.find((c: { clientId: string }) => c.clientId === CLIENT_ID);
const discovery = {
  authorizationEndpoint: "http://127.0.0.1:8080/realms/aurea-local/protocol/openid-connect/auth",
  tokenEndpoint: "http://127.0.0.1:8080/realms/aurea-local/protocol/openid-connect/token",
};

describe("authorization request", () => {
  it("is Authorization Code with PKCE S256 and no client secret", async () => {
    const request = buildAuthRequest();
    const url = new URL(await request.makeAuthUrlAsync(discovery));
    const q = url.searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe("aurea-mobile");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get("state")).toBeTruthy();
    expect(q.get("client_secret")).toBeNull();
    expect(request.codeVerifier).toBeTruthy();
    // RFC 7636: challenge = BASE64URL(SHA256(verifier))
    expect(q.get("code_challenge")).toBe(createHash("sha256").update(request.codeVerifier!).digest("base64url"));
  });

  it("uses exactly the redirect the realm allows, and the realm demands S256", () => {
    expect(mobile.redirectUris).toEqual([REDIRECT_URI]);
    expect(mobile.publicClient).toBe(true);
    expect(mobile.attributes["pkce.code.challenge.method"]).toBe("S256");
    const app = JSON.parse(readFileSync(join(__dirname, "../app.json"), "utf8")).expo;
    expect(REDIRECT_URI.startsWith(`${app.scheme}:`)).toBe(true);
    expect(app.android.package).toBe(app.scheme);
  });
});

describe("configuration fails closed", () => {
  const ok = { EXPO_PUBLIC_AUREA_ENV: "local", EXPO_PUBLIC_OIDC_ISSUER: "http://192.168.1.20:8080/realms/aurea-local", EXPO_PUBLIC_API_URL: "http://192.168.1.20:3000/" };
  it("accepts a local LAN config and trims the API slash", () => {
    expect(loadConfig(ok).apiUrl).toBe("http://192.168.1.20:3000");
  });
  it.each([
    ["no environment", { ...ok, EXPO_PUBLIC_AUREA_ENV: undefined }, /EXPO_PUBLIC_AUREA_ENV/],
    ["no issuer", { ...ok, EXPO_PUBLIC_OIDC_ISSUER: undefined }, /missing EXPO_PUBLIC_OIDC_ISSUER/],
    ["http issuer in production", { ...ok, EXPO_PUBLIC_AUREA_ENV: "production" }, /must use https in production/],
    ["http API in demo", { ...ok, EXPO_PUBLIC_AUREA_ENV: "demo", EXPO_PUBLIC_OIDC_ISSUER: "https://idp.example/r" }, /EXPO_PUBLIC_API_URL must use https/],
    ["garbage", { ...ok, EXPO_PUBLIC_API_URL: "not a url" }, /not a URL/],
  ])("%s", (_, env, re) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(re);
  });
});

it("Spanish and English catalogs have the same keys", () => {
  expect(Object.keys(en).sort()).toEqual(Object.keys(es).sort());
});
