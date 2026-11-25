// Fails when an installed npm dependency (prod or dev) has a license outside the allowlist.
// Copyleft or unknown licenses need a human legal review first (ADR-0014). Reads `pnpm licenses list`.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ALLOWED = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD"]);
/**
 * Named exceptions: one package, one license, one reason. Never copyleft. Each needs ian's OK in its PR.
 * caniuse-lite is browser-support data (not code) bundled by Next's build tooling; CC-BY-4.0 asks only
 * for attribution, which the SBOM and STATUS.md record. It does not ship in the browser bundle.
 */
export const EXCEPTIONS = { "caniuse-lite": "CC-BY-4.0" };

export function violations(report) {
  const out = [];
  for (const [license, pkgs] of Object.entries(report)) {
    if (ALLOWED.has(license)) continue;
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
