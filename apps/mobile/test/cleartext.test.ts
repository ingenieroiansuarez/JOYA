import { describe, expect, it } from "@jest/globals";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { applyToManifest, cleartextHosts, networkSecurityXml } = require("../plugins/with-dev-cleartext.js");

const local = {
  EXPO_PUBLIC_AUREA_ENV: "local",
  EXPO_PUBLIC_OIDC_ISSUER: "http://127.0.0.1:8080/realms/aurea-local",
  EXPO_PUBLIC_API_URL: "http://127.0.0.1:3900",
};

describe("release cleartext allowance", () => {
  it("allows http only to the configured local hosts and Metro", () => {
    expect(cleartextHosts(local)).toEqual(["127.0.0.1", "localhost"]);
  });
  it("adds nothing for demo or production builds", () => {
    expect(cleartextHosts({ ...local, EXPO_PUBLIC_AUREA_ENV: "production" })).toEqual([]);
    expect(cleartextHosts({ ...local, EXPO_PUBLIC_AUREA_ENV: "demo" })).toEqual([]);
  });
  it("does not open https hosts", () => {
    expect(cleartextHosts({ ...local, EXPO_PUBLIC_API_URL: "https://api.example.invalid" })).toEqual(["127.0.0.1", "localhost"]);
  });
  it("fails the build when a local build has no issuer", () => {
    expect(() => cleartextHosts({ EXPO_PUBLIC_AUREA_ENV: "local" })).toThrow("EXPO_PUBLIC_OIDC_ISSUER");
  });
  it("keeps https as the default for every other host", () => {
    const xml = networkSecurityXml(["127.0.0.1", "localhost"]);
    expect(xml).toContain('<base-config cleartextTrafficPermitted="false" />');
    expect(xml).toContain('<domain includeSubdomains="false">127.0.0.1</domain>');
  });
  it("removes a policy left by an earlier dev build from a production manifest", () => {
    const manifest = { manifest: { application: [{ $: { "android:networkSecurityConfig": "@xml/network_security_config" } }] } };
    applyToManifest(manifest, []);
    expect(manifest.manifest.application[0].$).toEqual({});
    applyToManifest(manifest, ["127.0.0.1"]);
    expect(manifest.manifest.application[0].$["android:networkSecurityConfig"]).toBe("@xml/network_security_config");
  });
});
