import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { localEnv } from "./bootstrap.mjs";

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

test("refuses to create credentials outside local/ci", () => {
  const script = fileURLToPath(new URL("./bootstrap.mjs", import.meta.url));
  const r = spawnSync(process.execPath, [script], { env: { ...process.env, AUREA_ENV: "production" }, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /only creates local credentials/);
});
