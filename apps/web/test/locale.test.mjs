import assert from "node:assert/strict";
import { test } from "node:test";
import { pickLocale } from "../lib/locale.ts";

test("Accept-Language quality values decide the locale", () => {
  assert.equal(pickLocale(null), "es");
  assert.equal(pickLocale("en-US,en;q=0.9"), "en");
  assert.equal(pickLocale("en;q=0,es;q=1"), "es"); // q=0 excludes English
  assert.equal(pickLocale("en;q=0.5,es;q=0.8"), "es"); // highest weight, not first listed
  assert.equal(pickLocale("fr,en;q=0.7,es;q=0.7"), "en"); // ties keep header order
  assert.equal(pickLocale("en;q=0"), "es");
  assert.equal(pickLocale("de,fr"), "es");
  assert.equal(pickLocale("en;q=abc"), "es"); // malformed weight is ignored
});
