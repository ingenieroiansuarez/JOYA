// The auth guard against tokens signed with local keys: every way a token can be wrong is a 401,
// a valid token without the permission is a 403, and an unreachable IdP is a 503, never a pass.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { after, before, describe, test } from "node:test";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { parse } from "yaml";

const require = createRequire(import.meta.url);
const { createApp } = require("../dist/app.js");
const { createVerifier, VerifierUnavailable } = require("../dist/identity/verifier.js");
const { REQUIRED_PERMISSION } = require("../dist/identity/permission.decorator.js");
const { MeController } = require("../dist/identity/me.controller.js");
const { ROLE_GRANTS } = require("../dist/identity/roles.generated.js");
const { Controller, Get } = require("@nestjs/common");

const ROOT = new URL("../../../", import.meta.url);
const api = parse(readFileSync(new URL("06_API_CONTRACTS/openapi.yaml", ROOT), "utf8"), { maxAliasCount: -1 });
const rolesDoc = JSON.parse(readFileSync(new URL("21_SECURITY/roles.reference.json", ROOT), "utf8"));
const ajv = new Ajv({ strict: false });
addFormats(ajv);
ajv.addSchema({ $id: "openapi", components: api.components });
const validMe = ajv.compile({ $ref: "openapi#/components/schemas/Me" });
const validError = ajv.compile({ $ref: "openapi#/components/schemas/Error" });

const ISSUER = "http://127.0.0.1:1/realms/test";
const CONFIG = {
  env: "ci", port: 0, databaseUrl: "postgresql://x@127.0.0.1:1/x", valkeyUrl: "redis://127.0.0.1:1",
  oidc: { issuer: ISSUER, audience: "aurea-api" },
};
const probes = { check: async () => ({ database: "ok", valkey: "ok" }), close: async () => {} };

// Authenticated, but declares no permission: must be refused for everyone.
class Undeclared { open() { return { leaked: true }; } }
Get("undeclared")(Undeclared.prototype, "open", Object.getOwnPropertyDescriptor(Undeclared.prototype, "open"));
Controller()(Undeclared);

let key, other, s;
const now = () => Math.floor(Date.now() / 1000);
async function token({ claims = {}, alg = "RS256", signer = key.privateKey, kid = "k1", iat = now(), exp = now() + 300 } = {}) {
  return new SignJWT({ realm_access: { roles: ["customer"] }, ...claims })
    .setProtectedHeader({ alg, kid })
    .setIssuer(claims.iss ?? ISSUER)
    .setAudience(claims.aud ?? "aurea-api")
    .setSubject("3c1e9f50-0000-4000-8000-000000000001")
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(signer);
}
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const get = (path, tok) => fetch(s.url(path), tok === undefined ? {} : { headers: { authorization: `Bearer ${tok}` } });

describe("auth guard", () => {
  before(async () => {
    key = await generateKeyPair("RS256");
    other = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(key.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    const verifier = await createVerifier(CONFIG, createLocalJWKSet({ keys: [jwk] }));
    const app = await createApp(CONFIG, probes, verifier, [Undeclared]);
    await app.listen(0, "127.0.0.1");
    const { port } = app.getHttpServer().address();
    s = { app, url: (p) => `http://127.0.0.1:${port}${p}` };
  });
  after(async () => { await s.app.close(); });

  test("a valid customer token reaches /v1/me in the contract shape", async () => {
    const r = await get("/v1/me", await token());
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(validMe(body), JSON.stringify(validMe.errors));
    assert.deepEqual(body.roles, ["customer"]);
    assert.deepEqual(body.permissions, [...rolesDoc.roles.customer].sort());
  });

  test("roles unknown to the contract are ignored, not trusted", async () => {
    const r = await get("/v1/me", await token({ claims: { realm_access: { roles: ["offline_access", "customer", "root"] } } }));
    assert.deepEqual((await r.json()).roles, ["customer"]);
  });

  test("clock skew inside 30 s is tolerated", async () => {
    assert.equal((await get("/v1/me", await token({ exp: now() - 10 }))).status, 200);
  });

  const bad = {
    "no header": async () => undefined,
    "not a JWT": async () => "abc",
    "expired beyond tolerance": () => token({ exp: now() - 120, iat: now() - 400 }),
    "wrong issuer": () => token({ claims: { iss: "http://127.0.0.1:1/realms/other" } }),
    "wrong audience": () => token({ claims: { aud: "aurea-mobile" } }),
    "signed by another key": () => token({ signer: other.privateKey }),
    "alg none": async () => `${b64({ alg: "none", typ: "JWT" })}.${b64({ iss: ISSUER, aud: "aurea-api", sub: "x", iat: now(), exp: now() + 300, realm_access: { roles: ["owner"] } })}.`,
    "HS256 with the public key as secret": async () =>
      token({ alg: "HS256", signer: new TextEncoder().encode(JSON.stringify(await exportJWK(key.publicKey))) }),
    "tampered payload": async () => {
      const [h, , sig] = (await token()).split(".");
      return `${h}.${b64({ iss: ISSUER, aud: "aurea-api", sub: "x", iat: now(), exp: now() + 300, realm_access: { roles: ["owner"] } })}.${sig}`;
    },
  };
  for (const [name, make] of Object.entries(bad)) {
    test(`401: ${name}`, async () => {
      const r = await get("/v1/me", await make());
      assert.equal(r.status, 401);
      const body = await r.json();
      assert.ok(validError(body));
      assert.equal(body.code, "UNAUTHENTICATED");
    });
  }

  test("a valid token without any contract role is 403", async () => {
    const r = await get("/v1/me", await token({ claims: { realm_access: { roles: ["offline_access"] } } }));
    assert.equal(r.status, 403);
    assert.equal((await r.json()).code, "FORBIDDEN");
  });

  test("a route that declares no permission is 403 even for the owner", async () => {
    const r = await get("/v1/undeclared", await token({ claims: { realm_access: { roles: ["owner"] } } }));
    assert.equal(r.status, 403);
    assert.equal((await r.json()).leaked, undefined);
  });
});

test("an unreachable identity provider is 503, never a pass", async () => {
  const verifier = await createVerifier({ ...CONFIG, oidc: { issuer: "http://127.0.0.1:9/realms/none", audience: "aurea-api" } });
  await assert.rejects(verifier.verify("a.b.c"), VerifierUnavailable);
  const app = await createApp(CONFIG, probes, { verify: async () => { throw new VerifierUnavailable("down"); } });
  await app.listen(0, "127.0.0.1");
  try {
    const { port } = app.getHttpServer().address();
    const r = await fetch(`http://127.0.0.1:${port}/v1/me`, { headers: { authorization: "Bearer a.b.c" } });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).code, "SERVICE_UNAVAILABLE");
  } finally {
    await app.close();
  }
});

test("route permissions match OpenAPI x-permission", () => {
  const op = api.paths["/me"].get;
  assert.equal(op.operationId, "getMe");
  assert.equal(Reflect.getMetadata(REQUIRED_PERMISSION, MeController.prototype.me), op["x-permission"]);
});

test("the generated role map matches roles.reference.json", () => {
  assert.deepEqual(Object.keys(ROLE_GRANTS), Object.keys(rolesDoc.roles));
  for (const [role, perms] of Object.entries(rolesDoc.roles)) assert.deepEqual(ROLE_GRANTS[role], [...perms].sort());
});
