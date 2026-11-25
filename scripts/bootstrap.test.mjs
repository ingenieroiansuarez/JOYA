import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { localEnv, missingLines } from "./bootstrap.mjs";

const parse = (text) => Object.fromEntries(
  text.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(/=(.*)/s).slice(0, 2)));

test("local env has distinct random passwords wired into the URLs", () => {
  const env = parse(localEnv({ pgPort: 5544, valkeyPort: 6655 }));
  assert.equal(env.AUREA_ENV, "local");
  assert.match(env.POSTGRES_PASSWORD, /^[0-9a-f]{48}$/);
  assert.notEqual(env.POSTGRES_PASSWORD, env.VALKEY_PASSWORD);
  assert.equal(env.DATABASE_URL, `postgresql://aurea_local:${env.POSTGRES_PASSWORD}@127.0.0.1:5544/aurea_local`);
  assert.equal(env.VALKEY_URL, `redis://:${env.VALKEY_PASSWORD}@127.0.0.1:6655`);
  assert.notEqual(parse(localEnv()).POSTGRES_PASSWORD, parse(localEnv()).POSTGRES_PASSWORD);
});

test("local env wires Keycloak secrets and the OIDC issuer", () => {
  const env = parse(localEnv({ kcPort: 8181 }));
  for (const k of ["KC_BOOTSTRAP_ADMIN_PASSWORD", "KC_CI_CLIENT_SECRET", "KC_DEV_USER_PASSWORD"]) {
    assert.match(env[k], /^[0-9a-f]{48}$/, k);
  }
  assert.equal(new Set(Object.values(env)).size, Object.keys(env).length);
  assert.equal(env.OIDC_ISSUER, "http://127.0.0.1:8181/realms/aurea-local");
  assert.equal(env.OIDC_AUDIENCE, "aurea-api");
});

test("an existing .env only gains missing keys, never new values", () => {
  const current = "# old\nAUREA_ENV=local\nPOSTGRES_PASSWORD=keep\n";
  const add = missingLines(current, localEnv());
  assert.ok(!add.some((l) => l.startsWith("POSTGRES_PASSWORD=") || l.startsWith("AUREA_ENV=")));
  assert.ok(add.some((l) => l.startsWith("KC_CI_CLIENT_SECRET=")));
  assert.deepEqual(missingLines(localEnv(), localEnv()), []);
});

test("refuses to create credentials outside local/ci", () => {
  const script = fileURLToPath(new URL("./bootstrap.mjs", import.meta.url));
  const r = spawnSync(process.execPath, [script], { env: { ...process.env, AUREA_ENV: "production" }, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /only creates local credentials/);
});

test("license gate rejects copyleft and unknown licenses", async () => {
  const { violations } = await import("./check-licenses.mjs");
  assert.deepEqual(violations({ MIT: [{ name: "a", versions: ["1.0.0"] }] }), []);
  assert.deepEqual(violations({ "GPL-3.0": [{ name: "g", versions: ["2.0.0"] }], Unknown: [{ name: "u", versions: ["0.1.0"] }] }),
    ["g@2.0.0: GPL-3.0", "u@0.1.0: Unknown"]);
});
