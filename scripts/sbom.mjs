// CycloneDX 1.6 SBOM for what this repository builds and runs, written to sbom/aurea.cdx.json.
//   node scripts/sbom.mjs          # write
//   node scripts/sbom.mjs --check  # exit 1 if the committed SBOM no longer matches the locks
// Sources, all pinned: pnpm-lock.yaml (npm, with integrity hashes; its importers and
// snapshots tell what ships vs dev-only), `pnpm licenses list` (declared licenses), services/*/requirements.lock
// (Python) and compose.yaml (container images by digest). Deterministic: no timestamp or random
// serial, components sorted, so the file changes only when a dependency does.
// Not covered yet: apps/render-bench-android (Gradle, a benchmark, not shipped).
import { execFileSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const SBOM_FILE = `${ROOT}sbom/aurea.cdx.json`;

/** purl for an npm package: the scope's @ is percent-encoded (purl spec). */
export const npmPurl = (name, version) => `pkg:npm/${name.replace(/^@/, "%40")}@${version}`;
export const pypiPurl = (name, version) => `pkg:pypi/${name.toLowerCase().replace(/[-_.]+/g, "-")}@${version}`;

/** name@version -> sha512 hex, from the pnpm v9 lockfile `packages:` section. */
export function lockIntegrity(lockText) {
  const out = new Map();
  const section = lockText.split(/^packages:\n/m)[1]?.split(/^snapshots:\n/m)[0] ?? "";
  const re = /^ {2}'?((?:@[^@\s']+\/)?[^@\s']+)@([^:'\s(]+)'?:\n {4}resolution: \{integrity: sha512-([A-Za-z0-9+/=]+)\}/gm;
  for (const m of section.matchAll(re)) out.set(`${m[1]}@${m[2]}`, Buffer.from(m[3], "base64").toString("hex"));
  return out;
}

/**
 * Every name@version reachable through the production dependencies of the workspace packages,
 * walked through the lockfile's `snapshots` (pnpm list --depth Infinity overflows on the Expo tree).
 */
export function prodSet(lock) {
  const base = (v) => v.replace(/\(.*$/, "");
  const seen = new Set();
  const stack = [];
  for (const imp of Object.values(lock.importers ?? {})) {
    for (const [name, d] of Object.entries(imp.dependencies ?? {})) stack.push([name, d.version]);
  }
  while (stack.length) {
    const [name, version] = stack.pop();
    if (version.startsWith("link:")) continue;
    const snap = `${name}@${version}`;
    if (seen.has(snap)) continue;
    seen.add(snap);
    const node = lock.snapshots?.[snap] ?? {};
    for (const [n, v] of Object.entries({ ...node.dependencies, ...node.optionalDependencies })) stack.push([n, v]);
  }
  return new Set([...seen].map((k) => { const at = k.indexOf("@", 1); return `${k.slice(0, at)}@${base(k.slice(at + 1))}`; }));
}

export function parseRequirements(text) {
  return text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => {
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s;#]+)$/.exec(l);
    if (!m) throw new Error(`unpinned requirement: ${l}`);
    return { name: m[1], version: m[2] };
  });
}

export function composeImages(composeText) {
  return [...composeText.matchAll(/^\s+image:\s*([^\s:@]+(?:\/[^\s:@]+)?):([^\s@]+)@(sha256:[0-9a-f]{64})\s*$/gm)]
    .map(([, name, tag, digest]) => ({ name, tag, digest }));
}

export function buildBom({ licenses, prod, integrity, python, images, version }) {
  const components = [];
  for (const [license, pkgs] of Object.entries(licenses)) {
    for (const p of pkgs) {
      for (const v of p.versions) {
        const key = `${p.name}@${v}`;
        const hash = integrity.get(key);
        components.push({
          type: "library",
          "bom-ref": npmPurl(p.name, v),
          name: p.name,
          version: v,
          scope: prod.has(key) ? "required" : "excluded",
          ...(license === "Unknown" ? {} : { licenses: [{ expression: license }] }),
          purl: npmPurl(p.name, v),
          ...(hash ? { hashes: [{ alg: "SHA-512", content: hash }] } : {}),
          properties: [{ name: "aurea:ecosystem", value: "npm" }],
        });
      }
    }
  }
  const py = new Map();
  for (const { service, reqs } of python) {
    for (const r of reqs) {
      const purl = pypiPurl(r.name, r.version);
      const c = py.get(purl) ?? { type: "library", "bom-ref": purl, name: r.name, version: r.version, scope: "required", purl, services: [] };
      c.services.push(service);
      py.set(purl, c);
    }
  }
  for (const c of py.values()) {
    const { services, ...rest } = c;
    // Licenses are not in the lock files; see STATUS.md for the reviewed ones. Never guessed here.
    components.push({ ...rest, properties: [{ name: "aurea:ecosystem", value: "pypi" }, ...services.sort().map((s) => ({ name: "aurea:service", value: s }))] });
  }
  for (const img of images) {
    const purl = `pkg:docker/${img.name}@${img.digest.replace(":", "%3A")}?tag=${img.tag}`;
    components.push({
      type: "container",
      "bom-ref": purl,
      name: img.name,
      version: img.tag,
      scope: "excluded", // local/CI compose only; production images are chosen per environment
      purl,
      hashes: [{ alg: "SHA-256", content: img.digest.slice(7) }],
      properties: [{ name: "aurea:ecosystem", value: "docker" }, { name: "aurea:usage", value: "compose local/ci" }],
    });
  }
  components.sort((a, b) => (a.purl < b.purl ? -1 : a.purl > b.purl ? 1 : 0));
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: { type: "application", "bom-ref": "aurea", name: "aurea", version },
      properties: [{ name: "aurea:not-covered", value: "apps/render-bench-android (Gradle benchmark, not shipped)" }],
    },
    components,
  };
}

/**
 * name@version of every package pnpm installed, from the store layout (`@scope+name@1.2.3_peers`).
 * `pnpm licenses list` sometimes drops a version that is installed only under an alias (react-is@18
 * as @jest/react-is-18), so the SBOM would change between identical installs. The directory listing
 * does not.
 */
export function installedPackages(storeDir) {
  if (!existsSync(storeDir)) return [];
  return readdirSync(storeDir).sort().flatMap((d) => {
    const m = /^((?:@[^+]+\+)?[^@]+)@([^_]+)/.exec(d);
    if (!m) return [];
    const name = m[1].replace("+", "/");
    return [{ name, version: m[2], manifest: `${storeDir}/${d}/node_modules/${name}/package.json` }];
  });
}

/** Add installed versions missing from `pnpm licenses list`, with the license their package.json declares. */
export function completeLicenses(licenses, installed, readManifest = (file) => JSON.parse(readFileSync(file, "utf8"))) {
  const out = Object.fromEntries(Object.entries(licenses).map(([l, ps]) => [l, ps.map((p) => ({ ...p, versions: [...p.versions] }))]));
  const have = new Set(Object.values(out).flat().flatMap((p) => p.versions.map((v) => `${p.name}@${v}`)));
  for (const { name, version, manifest } of installed) {
    if (have.has(`${name}@${version}`)) continue;
    const declared = readManifest(manifest).license;
    const license = typeof declared === "string" ? declared : "Unknown";
    out[license] ??= [];
    const entry = out[license].find((p) => p.name === name);
    if (entry) entry.versions.push(version);
    else out[license].push({ name, versions: [version] });
    have.add(`${name}@${version}`);
  }
  return out;
}

function collect() {
  const lockText = readFileSync(`${ROOT}pnpm-lock.yaml`, "utf8");
  const run = (args) => JSON.parse(execFileSync("pnpm", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 }));
  const python = readdirSync(`${ROOT}services`)
    .filter((s) => existsSync(`${ROOT}services/${s}/requirements.lock`))
    .sort()
    .map((s) => ({ service: s, reqs: parseRequirements(readFileSync(`${ROOT}services/${s}/requirements.lock`, "utf8")) }));
  return {
    licenses: completeLicenses(run(["licenses", "list", "--json"]), installedPackages(`${ROOT}node_modules/.pnpm`)),
    prod: prodSet(parseYaml(lockText, { maxAliasCount: -1 })),
    integrity: lockIntegrity(lockText),
    python,
    images: composeImages(readFileSync(`${ROOT}compose.yaml`, "utf8")),
    version: JSON.parse(readFileSync(`${ROOT}apps/api/package.json`, "utf8")).version,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = `${JSON.stringify(buildBom(collect()), null, 2)}\n`;
  if (process.argv.includes("--check")) {
    const current = existsSync(SBOM_FILE) ? readFileSync(SBOM_FILE, "utf8") : "";
    if (current !== text) {
      console.error("sbom/aurea.cdx.json is stale: run node scripts/sbom.mjs");
      // Show what differs so a CI-only mismatch can be diagnosed from the log.
      const a = current.split("\n"), b = text.split("\n");
      const only = (x, y) => { const set = new Set(y); return x.filter((l) => !set.has(l)); };
      for (const l of only(a, b).slice(0, 20)) console.error(`- ${l}`);
      for (const l of only(b, a).slice(0, 20)) console.error(`+ ${l}`);
      process.exit(1);
    }
    console.log("sbom OK");
  } else {
    writeFileSync(SBOM_FILE, text);
    const n = JSON.parse(text).components.length;
    console.log(`wrote sbom/aurea.cdx.json (${n} components)`);
  }
}
