// Fails when an installed npm dependency (prod or dev) has a license outside the allowlist.
// Copyleft or unknown licenses need a human legal review first (ADR-0014). Reads `pnpm licenses list`.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ALLOWED = new Set([
  "MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD",
  // Permissive, no copyleft, added with the Expo app (hito 100; ian's OK in that PR):
  "MIT-0", "BlueOak-1.0.0", "Unlicense", "Python-2.0",
]);
/**
 * Named exceptions: one package, one license, one reason. Strong copyleft never. Each needs ian's OK in its PR.
 * caniuse-lite is browser-support data (not code) bundled by Next's build tooling; CC-BY-4.0 asks only
 * for attribution, which the SBOM and STATUS.md record. It does not ship in the browser bundle.
 *
 * lightningcss (MPL-2.0, file-level weak copyleft) is the CSS transformer inside Expo's Metro config:
 * a build tool used unmodified, not bundled into the app. Any change to its files would have to be
 * published under MPL-2.0; we make none.
 */
export const EXCEPTIONS = {
  "caniuse-lite": "CC-BY-4.0",
  lightningcss: "MPL-2.0",
  "lightningcss-linux-x64-gnu": "MPL-2.0",
  "lightningcss-linux-x64-musl": "MPL-2.0",
};

/**
 * Evaluates an SPDX expression with its grouping: `A OR B` is acceptable when either side is (we take
 * that one), `A AND B` only when both are. AND binds tighter than OR, as in the SPDX spec. `WITH`
 * exceptions and anything unparseable are not acceptable, so they go to a human review.
 */
export function acceptable(license) {
  const tokens = license.match(/\(|\)|[^\s()]+/g) ?? [];
  let i = 0;
  const fail = () => { throw new Error("unparseable"); };
  const atom = () => {
    const t = tokens[i++];
    if (t === "(") { const v = or(); if (tokens[i++] !== ")") fail(); return v; }
    if (t === undefined || t === ")" || /^(AND|OR|WITH)$/.test(t)) fail();
    if (tokens[i] === "WITH") { i += 2; return false; }
    return ALLOWED.has(t);
  };
  const and = () => { let v = atom(); while (tokens[i] === "AND") { i++; v = atom() && v; } return v; };
  const or = () => { let v = and(); while (tokens[i] === "OR") { i++; v = and() || v; } return v; };
  try {
    const v = or();
    return i === tokens.length && v;
  } catch {
    return false;
  }
}

export function violations(report) {
  const out = [];
  for (const [license, pkgs] of Object.entries(report)) {
    if (acceptable(license)) continue;
    for (const p of pkgs) if (EXCEPTIONS[p.name] !== license) out.push(`${p.name}@${p.versions.join(",")}: ${license}`);
  }
  return out.sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = JSON.parse(execFileSync("pnpm", ["licenses", "list", "--json"], { encoding: "utf8" }));
  const bad = violations(report);
  const total = Object.values(report).reduce((n, p) => n + p.length, 0);
  if (bad.length) {
    console.error(`licenses outside the allowlist (${[...ALLOWED].join(", ")}):\n${bad.join("\n")}`);
    process.exit(1);
  }
  console.log(`licenses OK: ${total} packages, all in ${[...ALLOWED].join(", ")} or a named exception (${Object.keys(EXCEPTIONS).join(", ")})`);
}
