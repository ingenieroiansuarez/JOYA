import { describe, expect, it, jest } from "@jest/globals";
import type { DiscoveryDocument } from "expo-auth-session";
import { canPressSignIn, ensureDiscovery } from "../src/login";

const doc = { authorizationEndpoint: "https://idp.invalid/auth", tokenEndpoint: "https://idp.invalid/token" } as DiscoveryDocument;

describe("sign-in button", () => {
  it("waits for discovery before the first attempt", () => {
    expect(canPressSignIn(null, { kind: "signedOut" })).toBe(false);
    expect(canPressSignIn(doc, { kind: "signedOut" })).toBe(true);
  });
  it("stays pressable after discovery failed, so Retry can recover", () => {
    expect(canPressSignIn(null, { kind: "failed" })).toBe(true);
  });
  it("is disabled while a sign-in is running", () => {
    expect(canPressSignIn(doc, { kind: "busy" })).toBe(false);
  });
});

describe("ensureDiscovery", () => {
  it("fetches discovery again when the first attempt failed", async () => {
    const fetchDiscovery = jest.fn(async () => doc);
    await expect(ensureDiscovery(null, fetchDiscovery)).resolves.toBe(doc);
    expect(fetchDiscovery).toHaveBeenCalledTimes(1);
  });
  it("reuses a known document", async () => {
    const fetchDiscovery = jest.fn(async () => doc);
    await expect(ensureDiscovery(doc, fetchDiscovery)).resolves.toBe(doc);
    expect(fetchDiscovery).not.toHaveBeenCalled();
  });
  it("still fails when the IdP is unreachable", async () => {
    await expect(ensureDiscovery(null, async () => { throw new Error("offline"); })).rejects.toThrow("offline");
  });
});
