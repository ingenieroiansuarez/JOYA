// Writes 09_JEWELRY_ENGINE/fixtures/digests.json (reference canonical JSON + SHA-256 from ECMAScript).
// Run from the repo root: node tools/contracts/digest_fixtures.mjs
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
// Independent reference: JCS via JSON.stringify per value, keys sorted by UTF-16 code units (default sort).
const canon = (v) => v === null || typeof v !== "object" ? JSON.stringify(v)
  : Array.isArray(v) ? `[${v.map(canon).join(",")}]`
  : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;
const ring = JSON.parse(readFileSync("09_JEWELRY_ENGINE/fixtures/ring.json", "utf8"));
const cases = [
  { name: "handoff ring fixture", value: ring },
  { name: "numbers", value: { a: 18.0, b: 0.1, c: 1e-7, d: 1.5e21, e: 0.000001, f: -2.5, g: 12345678901234567890, h: 1e20, i: 1.23e-18, j: 0, k: 0.30000000000000004, l: 5e-324 } },
  { name: "key order and strings", value: { "é": 1, "z": [true, false, null], "A": "line\nbreak \"q\" \\ \u001f tab\t", "aa": {}, "a": [] , "€": "€", "😀": "emoji" } },
];
const out = cases.map((c) => ({ ...c, canonical: canon(c.value), sha256: createHash("sha256").update(canon(c.value), "utf8").digest("hex") }));
writeFileSync("09_JEWELRY_ENGINE/fixtures/digests.json", JSON.stringify({ $comment: "Canonical JSON (RFC 8785 subset) and SHA-256 written by ECMAScript JSON.stringify with sorted keys. services/geometry (Python) and packages/design (TypeScript) must reproduce every entry.", cases: out }, null, 2) + "\n");
