// AURA golden set (12_AI_ORCHESTRATION/golden/cases.json) against the active adapter, through the
// gateway's normalization. Fails on any unauthorized action; prints the score.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { newDocument } from "@aurea/design";

const require = createRequire(import.meta.url);
const { SimulatedAdapter } = require("../dist/ai/simulator.js");
const { normalize } = require("../dist/ai/ai.controller.js");
const golden = JSON.parse(readFileSync(new URL("../../../12_AI_ORCHESTRATION/golden/cases.json", import.meta.url), "utf8"));
const adapter = new SimulatedAdapter();

const value = (o, name) => o.changes.find((c) => c.name === name)?.to;

test(`golden set ≥ 30 adapter cases, ids unique`, () => {
  assert.ok(golden.cases.filter((c) => !c.coveredBy).length >= 30);
  assert.equal(new Set(golden.cases.map((c) => c.id)).size, golden.cases.length);
});

for (const c of golden.cases.filter((x) => !x.coveredBy)) {
  test(`${c.id} ${c.topic}`, async () => {
    const made = newDocument({ projectId: "00000000-0000-4000-8000-000000000000", familyId: c.family, materialId: "gold-18k-yellow" });
    assert.ok(made.ok);
    const raw = await adapter.generate({ prompt: c.prompt, document: made.document, locale: c.locale, maxOptions: 3 }, new AbortController().signal);
    const out = normalize(made.document, raw, 3);
    // Unauthorized action = adapter proposed something the gateway had to drop.
    assert.equal(out.options.length, raw.options.length, "every adapter option must survive validation");
    const e = c.expect;
    assert.equal(out.options.length, e.options, JSON.stringify(out));
    for (const o of out.options) {
      assert.ok(o.operations.every((op) => ["modify_parameter", "change_material"].includes(op.type)));
      for (const [k, v] of Object.entries(e.every ?? {})) assert.equal(value(o, k), v, `${k} in ${o.title}`);
      for (const k of e.forbidden ?? []) assert.equal(value(o, k), undefined, `${k} must not change`);
    }
    for (const [k, vs] of Object.entries(e.values ?? {})) assert.deepEqual(out.options.map((o) => value(o, k)), vs, k);
    const codes = out.notes.map((n) => n.code);
    for (const n of e.notes ?? []) assert.ok(codes.includes(n), `note ${n} in ${JSON.stringify(codes)}`);
  });
}
