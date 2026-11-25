import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { buildBom, composeImages, lockIntegrity, npmPurl, parseRequirements, prodSet, pypiPurl, SBOM_FILE } from "./sbom.mjs";

const schema = (f) => JSON.parse(readFileSync(new URL(`../tools/sbom/schema/${f}`, import.meta.url), "utf8"));

test("the committed SBOM is valid CycloneDX 1.6", () => {
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: true });
  addFormats(ajv);
  // ajv-formats has no IRI/IDN validators; the SBOM has no URL or email fields, so nothing is skipped.
  for (const f of ["iri-reference", "idn-email"]) ajv.addFormat(f, true);
  ajv.addSchema(schema("spdx.schema.json"), "spdx.schema.json");
  ajv.addSchema(schema("jsf-0.82.schema.json"), "jsf-0.82.schema.json");
  const validate = ajv.compile(schema("bom-1.6.schema.json"));
  const bom = JSON.parse(readFileSync(SBOM_FILE, "utf8"));
  assert.ok(validate(bom), JSON.stringify(validate.errors?.slice(0, 5)));
  const refs = bom.components.map((c) => c["bom-ref"]);
  assert.equal(new Set(refs).size, refs.length, "duplicate bom-ref");
  for (const c of bom.components) {
    assert.match(c.version, /^[0-9A-Za-z.+_-]+$/, `${c.name} has no exact version`);
    if (c.properties[0].value === "npm") assert.ok(c.hashes?.length, `${c.name} has no integrity hash`);
  }
});

test("purls follow the spec", () => {
  assert.equal(npmPurl("@nestjs/core", "12.6.1"), "pkg:npm/%40nestjs/core@12.6.1");
  assert.equal(pypiPurl("Jsonschema_Specifications", "2025.9.1"), "pkg:pypi/jsonschema-specifications@2025.9.1");
});

test("lock integrity is read for scoped and plain packages", () => {
  const lock = "packages:\n\n  '@a/b@1.0.0':\n    resolution: {integrity: sha512-AAAA}\n\n  c@2.0.0:\n    resolution: {integrity: sha512-//8=}\n\nsnapshots:\n\n  c@2.0.0: {}\n";
  const m = lockIntegrity(lock);
  assert.equal(m.get("@a/b@1.0.0"), "000000");
  assert.equal(m.get("c@2.0.0"), "ffff");
});

test("dev-only packages are marked excluded, shipped ones required", () => {
  const prod = prodSet([{ dependencies: { a: { version: "1.0.0", dependencies: { b: { version: "2.0.0" } } }, ws: { version: "link:../ws" } } }]);
  assert.deepEqual([...prod].sort(), ["a@1.0.0", "b@2.0.0"]);
  const bom = buildBom({
    licenses: { MIT: [{ name: "a", versions: ["1.0.0"] }, { name: "t", versions: ["3.0.0"] }] },
    prod, integrity: new Map(), python: [], images: [], version: "0.0.0",
  });
  assert.deepEqual(bom.components.map((c) => [c.name, c.scope]), [["a", "required"], ["t", "excluded"]]);
});

test("Python requirements must be pinned exactly", () => {
  assert.deepEqual(parseRequirements("# x\nnumpy==2.5.5\n"), [{ name: "numpy", version: "2.5.5" }]);
  assert.throws(() => parseRequirements("numpy>=2\n"), /unpinned/);
});

test("compose images are recorded by digest", () => {
  const imgs = composeImages(readFileSync(new URL("../compose.yaml", import.meta.url), "utf8"));
  assert.ok(imgs.length >= 3);
  for (const i of imgs) assert.match(i.digest, /^sha256:[0-9a-f]{64}$/);
});
