// End to end against the Keycloak in compose (skipped when .env is not loaded):
// the API accepts real tokens, and the mobile client only gets one through Authorization Code + PKCE.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { after, before, describe, test } from "node:test";

const require = createRequire(import.meta.url);
const { createApp } = require("../dist/app.js");
const { loadConfig } = require("../dist/config.js");
const { createVerifier } = require("../dist/identity/verifier.js");

const { OIDC_ISSUER: ISSUER, KC_CI_CLIENT_SECRET: CI_SECRET, KC_DEV_USER_PASSWORD: DEV_PASSWORD } = process.env;
const skip = ISSUER && CI_SECRET && DEV_PASSWORD ? false : "Keycloak env not loaded (source .env)";
const REDIRECT = "com.aurea.customer.dev:/oauthredirect";
const TOKEN_URL = `${ISSUER}/protocol/openid-connect/token`;
const probes = { check: async () => ({ database: "ok", valkey: "ok" }), close: async () => {} };

const form = (o) => new URLSearchParams(o);
const b64url = (b) => b.toString("base64url");

/** Drives the Keycloak login page like a browser would and returns the authorization code. */
async function authorize(challenge) {
  const state = b64url(randomBytes(16));
  const params = { client_id: "aurea-mobile", response_type: "code", scope: "openid", redirect_uri: REDIRECT, state };
  if (challenge) Object.assign(params, { code_challenge: challenge, code_challenge_method: "S256" });
  const page = await fetch(`${ISSUER}/protocol/openid-connect/auth?${form(params)}`, { redirect: "manual" });
  if (page.status === 302) return { refused: new URL(page.headers.get("location")).searchParams };
  const cookies = page.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const html = await page.text();
  const action = /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/.exec(html)?.[1]?.replaceAll("&amp;", "&");
  if (!action) return { page: page.status, html };
  const login = await fetch(action, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: cookies, "content-type": "application/x-www-form-urlencoded" },
    body: form({ username: "dev.cliente", password: DEV_PASSWORD, credentialId: "" }),
  });
  if (!login.headers.get("location")) return { login: login.status, html: await login.text() };
  const location = new URL(login.headers.get("location"));
  assert.equal(location.searchParams.get("state"), state);
  return { code: location.searchParams.get("code") };
}

describe("Keycloak in compose", { skip }, () => {
  let s;
  before(async () => {
    const config = loadConfig({ ...process.env, API_PORT: "0" });
    const app = await createApp(config, probes, await createVerifier(config));
    await app.listen(0, "127.0.0.1");
    const { port } = app.getHttpServer().address();
    s = { app, url: (p) => `http://127.0.0.1:${port}${p}` };
  });
  after(async () => { await s?.app.close(); });

  test("a CI service account token reaches /v1/me as auditor", async () => {
    const t = await (await fetch(TOKEN_URL, {
      method: "POST",
      body: form({ grant_type: "client_credentials", client_id: "aurea-ci", client_secret: CI_SECRET }),
    })).json();
    assert.ok(t.access_token, JSON.stringify(t));
    const r = await fetch(s.url("/v1/me"), { headers: { authorization: `Bearer ${t.access_token}` } });
    assert.equal(r.status, 200);
    const me = await r.json();
    assert.deepEqual(me.roles, ["auditor"]);
    assert.ok(me.permissions.includes("identity.self"));
  });

  test("a wrong client secret gets no token", async () => {
    const r = await fetch(TOKEN_URL, { method: "POST", body: form({ grant_type: "client_credentials", client_id: "aurea-ci", client_secret: "wrong" }) });
    assert.equal(r.status, 401);
  });

  test("the mobile client cannot log in with a password grant", async () => {
    const r = await fetch(TOKEN_URL, {
      method: "POST",
      body: form({ grant_type: "password", client_id: "aurea-mobile", username: "dev.cliente", password: DEV_PASSWORD }),
    });
    assert.ok(r.status >= 400);
    assert.equal((await r.json()).access_token, undefined);
  });

  test("the mobile client must send a PKCE challenge", async () => {
    const { refused } = await authorize(null);
    assert.equal(refused.get("error"), "invalid_request");
    assert.match(refused.get("error_description"), /code_challenge/);
    assert.equal(refused.get("code"), null);
  });

  test("Authorization Code + PKCE S256 logs dev.cliente in, and the code needs the verifier", async () => {
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const { code } = await authorize(challenge);
    assert.ok(code);
    const exchange = (extra) => fetch(TOKEN_URL, {
      method: "POST",
      body: form({ grant_type: "authorization_code", client_id: "aurea-mobile", code, redirect_uri: REDIRECT, ...extra }),
    }).then((r) => r.json());
    const withoutVerifier = await exchange({});
    assert.equal(withoutVerifier.access_token, undefined);
    const wrong = await exchange({ code_verifier: b64url(randomBytes(32)) });
    assert.equal(wrong.access_token, undefined);
    // Keycloak spends the code on a failed attempt, so log in again for the good exchange.
    const verifier2 = b64url(randomBytes(32));
    const second = await authorize(b64url(createHash("sha256").update(verifier2).digest()));
    const t = await fetch(TOKEN_URL, {
      method: "POST",
      body: form({ grant_type: "authorization_code", client_id: "aurea-mobile", code: second.code, redirect_uri: REDIRECT, code_verifier: verifier2 }),
    }).then((r) => r.json());
    assert.ok(t.access_token, JSON.stringify(t));
    const me = await (await fetch(s.url("/v1/me"), { headers: { authorization: `Bearer ${t.access_token}` } })).json();
    assert.deepEqual(me.roles, ["customer"]);
    // The ID token is for the app, not the API: its audience is aurea-mobile.
    const r = await fetch(s.url("/v1/me"), { headers: { authorization: `Bearer ${t.id_token}` } });
    assert.equal(r.status, 401);
  });
});
