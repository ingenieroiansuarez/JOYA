import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { buildBom, completeLicenses, composeImages, installedPackages, lockIntegrity, npmPurl, parseRequirements, prodSet, pypiPurl, SBOM_FILE } from "./sbom.mjs";

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
  const prod = prodSet({
    importers: {
      app: { dependencies: { a: { version: "1.0.0(peer@1.0.0)" }, ws: { version: "link:../ws" } }, devDependencies: { t: { version: "3.0.0" } } },
    },
    snapshots: { "a@1.0.0(peer@1.0.0)": { dependencies: { "@s/b": "2.0.0" } }, "@s/b@2.0.0": {}, "t@3.0.0": {} },
  });
  assert.deepEqual([...prod].sort(), ["@s/b@2.0.0", "a@1.0.0"]);
  const bom = buildBom({
    licenses: { MIT: [{ name: "a", versions: ["1.0.0"] }, { name: "@s/b", versions: ["2.0.0"] }, { name: "t", versions: ["3.0.0"] }] },
    prod, integrity: new Map(), python: [], images: [], version: "0.0.0",
  });
  assert.deepEqual(bom.components.map((c) => [c.name, c.scope]), [["@s/b", "required"], ["a", "required"], ["t", "excluded"]]);
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

test("a version pnpm licenses leaves out (installed only under an alias) still gets a component", () => {
  const dir = mkdtempSync(join(tmpdir(), "aurea-store-"));
  for (const [d, name, license] of [["react-is@18.3.1", "react-is", "MIT"], ["react-is@19.3.1", "react-is", "MIT"], ["@scope+x@1.0.0_peer@2", "@scope/x", "ISC"]]) {
    mkdirSync(join(dir, d, "node_modules", name), { recursive: true });
    writeFileSync(join(dir, d, "node_modules", name, "package.json"), JSON.stringify({ name, license }));
  }
  const installed = installedPackages(dir);
  assert.deepEqual(installed.map((p) => `${p.name}@${p.version}`), ["@scope/x@1.0.0", "react-is@18.3.1", "react-is@19.3.1"]);
  const listed = { MIT: [{ name: "react-is", versions: ["19.3.1"] }] };
  const out = completeLicenses(listed, installed);
  assert.deepEqual(out.MIT, [{ name: "react-is", versions: ["19.3.1", "18.3.1"] }]);
  assert.deepEqual(out.ISC, [{ name: "@scope/x", versions: ["1.0.0"] }]);
  assert.deepEqual(listed.MIT[0].versions, ["19.3.1"]); // input untouched
});
