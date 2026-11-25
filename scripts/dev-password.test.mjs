import assert from "node:assert/strict";
import { test } from "node:test";
import { envValue, plan } from "./dev-password.mjs";

const pw = "a".repeat(24) + "0123456789abcdef0123456789abcdef";
const env = `# x\r\nAUREA_ENV=local\r\nKC_DEV_USER_PASSWORD=${pw}\r\n`;

test("reads keys from .env with CRLF and comments", () => {
  assert.equal(envValue(env, "AUREA_ENV"), "local");
  assert.equal(envValue(env, "KC_DEV_USER_PASSWORD"), pw);
  assert.equal(envValue(env, "NOPE"), undefined);
});

test("types the password, optionally Enter, optionally on one device", () => {
  assert.deepEqual(plan(env), [["shell", "input", "text", pw]]);
  assert.deepEqual(plan(env, { enter: true, serial: "R3X" }), [
    ["-s", "R3X", "shell", "input", "text", pw],
    ["-s", "R3X", "shell", "input", "keyevent", "66"],
  ]);
});

test("refuses outside local, without the key, or with shell-unsafe values, never echoing them", () => {
  for (const [text, re] of [
    [env.replace("local", "production"), /AUREA_ENV=production/],
    ["AUREA_ENV=local\n", /no está en .env/],
    ["AUREA_ENV=local\nKC_DEV_USER_PASSWORD=abc;rm -rf x&&$(id)\n", /hexadecimal/],
  ]) {
    assert.throws(() => plan(text), (e) => re.test(e.message) && !e.message.includes("rm -rf") && !e.message.includes(pw));
  }
});
