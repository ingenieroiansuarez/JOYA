import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { childEnv, demoEnv, loadDemo, parseEnv, PORTS } from "./demo.mjs";
import { localEnv } from "./bootstrap.mjs";

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

test("demo env: AUREA_ENV=demo, simulated providers, its own ports and database", () => {
  const env = parseEnv(demoEnv({ root: "/r", random: () => "ab".repeat(24) }));
  assert.equal(env.AUREA_ENV, "demo");
  assert.equal(env.PAYMENT_PROVIDER, "simulated");
  assert.equal(env.AI_PROVIDER, "simulated");
  assert.match(env.DATABASE_URL, /@127\.0\.0\.1:5434\/aurea_demo$/);
  assert.equal(env.OIDC_ISSUER, "http://127.0.0.1:8180/realms/aurea-demo");
  assert.equal(env.API_PUBLIC_URL, "http://127.0.0.1:3901");
  assert.equal(env.WEB_ORIGIN, "http://127.0.0.1:3101");
  assert.ok(env.ARTIFACT_DIR.includes("demo"));
  const local = parseEnv(localEnv({ random: () => "cd".repeat(24) }));
  for (const k of ["DATABASE_URL", "VALKEY_URL", "OIDC_ISSUER", "API_PORT", "ARTIFACT_DIR", "GEOMETRY_WORKER_URL"]) {
    assert.notEqual(env[k], local[k], `${k} must differ from local development`);
  }
});

test("demo secrets are random per bootstrap and distinct from each other", () => {
  const a = parseEnv(demoEnv());
  const b = parseEnv(demoEnv());
  const secrets = ["POSTGRES_PASSWORD", "KC_DEMO_CUSTOMER_PASSWORD", "KC_DEMO_STAFF_PASSWORD", "KC_WEB_CLIENT_SECRET",
    "GEOMETRY_WORKER_SECRET", "FILE_URL_SECRET", "PAYMENT_WEBHOOK_SECRET", "WEB_SESSION_SECRET"];
  for (const k of secrets) assert.notEqual(a[k], b[k]);
  assert.equal(new Set(secrets.map((k) => a[k])).size, secrets.length);
});

test("loadDemo fails closed", () => {
  const ok = demoEnv({ random: () => "ab".repeat(24) });
  assert.equal(loadDemo(ok).AUREA_ENV, "demo");
  assert.throws(() => loadDemo(ok.replace("AUREA_ENV=demo", "AUREA_ENV=production")), /solo demo/);
  assert.throws(() => loadDemo(ok.replace(/^KC_DEMO_STAFF_PASSWORD=.*$/m, "")), /incompleto \(KC_DEMO_STAFF_PASSWORD\)/);
  assert.throws(() => loadDemo(ok.replace(":5434/aurea_demo", ":5434/aurea_local")), /no es la base aurea_demo/);
  assert.throws(() => loadDemo(ok.replace("@127.0.0.1:5434", "@db.example:5432")), /no es la base aurea_demo/);
});

test("children never inherit the local AUREA variables of the shell", () => {
  const shell = { PATH: "/bin", Path: "C:\\x", DATABASE_URL: "postgresql://local/aurea_local", KC_DEV_USER_PASSWORD: "x", Aurea_env: "local", API_PORT: "3900", NEXT_DIST_DIR: ".next" };
  const env = childEnv(shell, { AUREA_ENV: "demo", DATABASE_URL: "postgresql://demo/aurea_demo" });
  assert.deepEqual(env, { PATH: "/bin", Path: "C:\\x", AUREA_ENV: "demo", DATABASE_URL: "postgresql://demo/aurea_demo" });
});

test("compose.demo.yaml is separate from compose.yaml: project, volumes, ports, realm", () => {
  const local = parse(read("compose.yaml"));
  const demo = parse(read("compose.demo.yaml"));
  assert.notEqual(demo.name, local.name);
  assert.deepEqual(Object.keys(demo.services).sort(), Object.keys(local.services).sort());
  for (const [name, svc] of Object.entries(demo.services)) {
    assert.equal(svc.image, local.services[name].image, `${name}: same pinned image`);
    assert.deepEqual(svc.env_file, [".env.demo"]);
    for (const p of svc.ports) assert.match(p, /^127\.0\.0\.1:/, `${name} binds loopback only`);
  }
  assert.ok(Object.keys(demo.volumes).every((v) => !(v in local.volumes)));
  assert.deepEqual(demo.services.postgres.ports, [`127.0.0.1:${PORTS.postgres}:5432`]);
  assert.equal(demo.services.postgres.environment.POSTGRES_DB, "aurea_demo");
  assert.deepEqual(demo.services.keycloak.volumes, ["./infra/keycloak-demo:/opt/keycloak/data/import:ro"]);
});

test("demo realm: no CI client, demo redirect, synthetic personas only", () => {
  const realm = JSON.parse(read("infra/keycloak-demo/realm-aurea-demo.json"));
  assert.equal(realm.realm, "aurea-demo");
  assert.ok(!realm.clients.some((c) => c.clientId === "aurea-ci"));
  assert.deepEqual(realm.clients.find((c) => c.clientId === "aurea-mobile").redirectUris, ["com.aurea.customer.demo:/oauthredirect"]);
  assert.deepEqual(realm.clients.find((c) => c.clientId === "aurea-web").redirectUris, ["http://127.0.0.1:3101/auth/callback"]);
  for (const u of realm.users) {
    assert.match(u.username, /^demo\./);
    assert.match(u.email, /@aurea\.invalid$/);
    assert.match(u.credentials[0].value, /^\$\{KC_DEMO_(CUSTOMER|STAFF)_PASSWORD\}$/);
  }
  const roles = Object.fromEntries(realm.users.map((u) => [u.username, u.realmRoles]));
  assert.deepEqual(roles["demo.cliente"], ["customer"]);
  assert.deepEqual(roles["demo.inspector"], ["inspector"]);
});

test(".env.demo and the demo build folder are git-ignored", () => {
  const ignore = read(".gitignore");
  assert.match(ignore, /^\*\*\/\.env\.demo$/m);
  assert.match(ignore, /^apps\/web\/\.next-demo\/$/m);
});
