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
  const secrets = Object.values(env).filter((v) => /^[0-9a-f]{48}$/.test(v));
  assert.equal(new Set(secrets).size, secrets.length);
  assert.equal(env.OIDC_ISSUER, "http://127.0.0.1:8181/realms/aurea-local");
  assert.equal(env.OIDC_AUDIENCE, "aurea-api");
});

test("local env wires the simulated payment provider, the web client and the staff user (hito 500)", () => {
  const env = parse(localEnv());
  assert.equal(env.PAYMENT_PROVIDER, "simulated");
  for (const k of ["PAYMENT_WEBHOOK_SECRET", "KC_WEB_CLIENT_SECRET", "KC_DEV_STAFF_PASSWORD", "WEB_SESSION_SECRET"]) assert.match(env[k], /^[0-9a-f]{48}$/, k);
  assert.notEqual(env.KC_DEV_STAFF_PASSWORD, env.KC_DEV_USER_PASSWORD);
});

test("local env wires the geometry worker and distinct signing secrets", () => {
  const env = parse(localEnv({ workerPort: 3999, artifactDir: "/x/.data/artifacts" }));
  assert.equal(env.GEOMETRY_WORKER_URL, "http://127.0.0.1:3999");
  assert.equal(env.GEOMETRY_WORKER_PORT, "3999");
  for (const k of ["GEOMETRY_WORKER_SECRET", "FILE_URL_SECRET"]) assert.match(env[k], /^[0-9a-f]{48}$/, k);
  assert.notEqual(env.GEOMETRY_WORKER_SECRET, env.FILE_URL_SECRET);
  assert.equal(env.ARTIFACT_DIR, "/x/.data/artifacts");
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
  // An exception covers one package under one license only.
  assert.deepEqual(violations({ "CC-BY-4.0": [{ name: "caniuse-lite", versions: ["1.0.0"] }, { name: "other", versions: ["1.0.0"] }] }),
    ["other@1.0.0: CC-BY-4.0"]);
  assert.deepEqual(violations({ "GPL-3.0": [{ name: "caniuse-lite", versions: ["1.0.0"] }] }), ["caniuse-lite@1.0.0: GPL-3.0"]);
  // OR-expressions pass when one alternative is allowed; AND or all-copyleft alternatives do not.
  assert.deepEqual(violations({ "(BSD-3-Clause OR GPL-2.0)": [{ name: "f", versions: ["1.0.0"] }] }), []);
  assert.deepEqual(violations({ "(GPL-2.0 OR LGPL-3.0)": [{ name: "f", versions: ["1.0.0"] }] }), ["f@1.0.0: (GPL-2.0 OR LGPL-3.0)"]);
  assert.deepEqual(violations({ "(MIT AND GPL-2.0)": [{ name: "f", versions: ["1.0.0"] }] }), ["f@1.0.0: (MIT AND GPL-2.0)"]);
  // Grouping is kept: an OR inside parentheses does not excuse a copyleft AND outside them.
  const v = (license) => violations({ [license]: [{ name: "f", versions: ["1.0.0"] }] });
  assert.deepEqual(v("(MIT OR Apache-2.0) AND GPL-3.0"), ["f@1.0.0: (MIT OR Apache-2.0) AND GPL-3.0"]);
  assert.deepEqual(v("GPL-3.0 AND (MIT OR Apache-2.0)"), ["f@1.0.0: GPL-3.0 AND (MIT OR Apache-2.0)"]);
  assert.deepEqual(v("MIT AND (Apache-2.0 OR GPL-3.0)"), []);
  assert.deepEqual(v("GPL-3.0 OR MIT AND ISC"), []);
  assert.deepEqual(v("GPL-3.0 OR MIT AND LGPL-3.0"), ["f@1.0.0: GPL-3.0 OR MIT AND LGPL-3.0"]);
  assert.deepEqual(v("Apache-2.0 WITH LLVM-exception"), ["f@1.0.0: Apache-2.0 WITH LLVM-exception"]);
  assert.deepEqual(v("(MIT OR"), ["f@1.0.0: (MIT OR"]);
  assert.deepEqual(violations({ "MPL-2.0": [{ name: "lightningcss-x", versions: ["1.0.0"] }] }), ["lightningcss-x@1.0.0: MPL-2.0"]);
});

test("local env sets the API port and keeps AURA on the rules simulator", () => {
  const env = parse(localEnv({ apiPort: 3999 }));
  assert.equal(env.API_PORT, "3999");
  assert.equal(env.AI_PROVIDER, "simulated");
  assert.equal(parse(localEnv()).API_PORT, "3900");
});
