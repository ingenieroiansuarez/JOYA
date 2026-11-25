import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  applyAll, applyOperation, canonicalJson, canRebase, diffParameters, FAMILIES, MATERIALS, newDocument, validateDocument,
} from "../design.mjs";

const root = new URL("../../../", import.meta.url);
const read = (p) => JSON.parse(readFileSync(new URL(p, root), "utf8"));
const PID = "00000000-0000-4000-8000-000000000001";
const ring = () => newDocument({ projectId: PID, familyId: "ring.02", materialId: "gold-18k-yellow" }).document;

test("canonical JSON and SHA-256 match the shared reference cases (same as services/geometry)", () => {
  for (const c of read("09_JEWELRY_ENGINE/fixtures/digests.json").cases) {
    assert.equal(canonicalJson(c.value), c.canonical, c.name);
    assert.equal(createHash("sha256").update(canonicalJson(c.value), "utf8").digest("hex"), c.sha256, c.name);
  }
  assert.throws(() => canonicalJson({ x: NaN }), RangeError);
  assert.throws(() => canonicalJson({ x: Infinity }), RangeError);
});

test("catalog follows families.json ranges and lists only what the engine builds", () => {
  const library = read("11_3D_ASSET_LIBRARY/families.json");
  const build = readFileSync(new URL("services/geometry/aurea_geometry/build.py", root), "utf8");
  for (const f of FAMILIES) {
    const src = library.find((x) => x.id === f.id);
    assert.equal(f.version, src.version);
    for (const p of f.parameters) {
      const s = src.parameters[p.name];
      assert.deepEqual([p.min, p.max, p.default, p.unit], [s.min, s.max, s.default, s.unit]);
    }
    assert.match(build, new RegExp(`"${f.id.replace(".", "\\.")}": _`), `${f.id} has a generator`);
  }
  assert.deepEqual(FAMILIES.map((f) => f.id), ["ring.classic", "ring.02", "pendant.01", "pendant.02"]);
  for (const m of MATERIALS) assert.match(m.densityGPerCm3, /^\d+(\.\d+)?$/, "density is a decimal string");
});

test("a new project starts at revision 1 with the family defaults and no invented DFM rule", () => {
  const doc = ring();
  assert.equal(doc.revision, 1);
  assert.deepEqual(doc.components[0].parameters, { innerDiameter: 18, bandWidth: 4, radialThickness: 1.8 });
  assert.deepEqual(doc.constraints, []);
  assert.deepEqual(validateDocument(doc), []);
  // The handoff ring fixture (validated by services/geometry) is valid here too.
  assert.deepEqual(validateDocument(read("09_JEWELRY_ENGINE/fixtures/ring.json")), []);
});

test("unknown family or material is refused", () => {
  assert.equal(newDocument({ projectId: PID, familyId: "ring.99", materialId: "gold-18k-yellow" }).issues[0].code, "UNKNOWN_FAMILY");
  assert.equal(newDocument({ projectId: PID, familyId: "ring.02", materialId: "unobtainium" }).issues[0].code, "UNKNOWN_MATERIAL");
});

test("modify_parameter produces the next revision without touching the input", () => {
  const doc = ring();
  const r = applyOperation(doc, { type: "modify_parameter", componentId: "ring-base", name: "innerDiameter", value: 19.5 });
  assert.ok(r.ok);
  assert.equal(r.document.revision, 2);
  assert.equal(r.document.components[0].parameters.innerDiameter, 19.5);
  assert.equal(doc.components[0].parameters.innerDiameter, 18);
  assert.deepEqual(diffParameters(doc, r.document), [{ componentId: "ring-base", name: "innerDiameter", from: 18, to: 19.5 }]);
});

for (const [label, op, code] of [
  ["above range", { name: "innerDiameter", value: 40 }, "OUT_OF_RANGE"],
  ["below range", { name: "radialThickness", value: 0.5 }, "OUT_OF_RANGE"],
  ["NaN", { name: "bandWidth", value: NaN }, "NOT_FINITE"],
  ["string", { name: "bandWidth", value: "4" }, "NOT_A_NUMBER"],
  ["unknown parameter", { name: "height", value: 10 }, "UNKNOWN_PARAMETER"],
  ["unknown component", { componentId: "nope", name: "bandWidth", value: 4 }, "UNKNOWN_COMPONENT"],
]) {
  test(`invalid input is rejected, never clamped: ${label}`, () => {
    const r = applyOperation(ring(), { type: "modify_parameter", componentId: "ring-base", ...op });
    assert.equal(r.ok, false);
    assert.equal(r.issues[0].code, code);
  });
}

test("change_material accepts only catalogued alloys", () => {
  assert.ok(applyOperation(ring(), { type: "change_material", componentId: "ring-base", materialId: "platinum-950" }).ok);
  const r = applyOperation(ring(), { type: "change_material", componentId: "ring-base", materialId: "gold-24k" });
  assert.equal(r.issues[0].code, "UNKNOWN_MATERIAL");
});

test("operations outside the hito 300 subset are refused, not ignored", () => {
  for (const type of ["create_ring", "create_setting", "place_gemstone", "boolean_union", "engrave_surface", "pattern_on_curve", "rm -rf"]) {
    assert.equal(applyOperation(ring(), { type }).issues[0].code, "UNSUPPORTED_OPERATION", type);
  }
});

test("applyAll stops at the first rejected operation", () => {
  const r = applyAll(ring(), [
    { type: "modify_parameter", componentId: "ring-base", name: "bandWidth", value: 5 },
    { type: "modify_parameter", componentId: "ring-base", name: "bandWidth", value: 50 },
  ]);
  assert.equal(r.ok, false);
});

test("rebase only across independent parameters (no last-write-wins)", () => {
  const width = { type: "modify_parameter", componentId: "ring-base", name: "bandWidth", value: 5 };
  const width2 = { ...width, value: 6 };
  const diameter = { type: "modify_parameter", componentId: "ring-base", name: "innerDiameter", value: 19 };
  const metal = { type: "change_material", componentId: "ring-base", materialId: "silver-925" };
  assert.equal(canRebase(width, [diameter, metal]), true);
  assert.equal(canRebase(width, [diameter, width2]), false);
  assert.equal(canRebase(metal, [metal]), false);
  assert.equal(canRebase({ type: "create_ring" }, []), false);
});
