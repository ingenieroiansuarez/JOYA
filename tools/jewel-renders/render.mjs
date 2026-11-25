// Renders the catalog illustrations into apps/mobile/assets/catalog (JPEG, committed) and writes
// apps/mobile/src/catalogArt.generated.ts mapping SKU → image. Free and local: three.js from the
// mobile app's node_modules and a headless Chromium (Playwright). No network.
//   node tools/jewel-renders/render.mjs            # all pieces
//   node tools/jewel-renders/render.mjs AUR-RNG-002 # one SKU (for tuning)
//   node tools/jewel-renders/render.mjs --sheet f.png  # also a contact sheet to review them at once
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "../..");
const THREE = join(ROOT, "apps/mobile/node_modules/three");
const OUT = join(ROOT, "apps/mobile/assets/catalog");
const MAP = join(ROOT, "apps/mobile/src/catalogArt.generated.ts");
const DESIGN_OUT = join(ROOT, "apps/mobile/assets/design");
const DESIGN_MAP = join(ROOT, "apps/mobile/src/design/designArt.generated.ts");
// Design families (packages/design) rendered from the geometry service's real GLB_PREVIEW at their
// default parameters, in every alloy. Produce the GLBs with `aurea-geometry` (see README.md).
export const FAMILY_GLB = { "ring.classic": "ring-base.glb", "ring.02": "ring-base.glb", "pendant.01": "pendant-base.glb", "pendant.02": "pendant-base.glb" };
export const ALLOYS = { "gold-18k-yellow": "GOLD_18K_YELLOW", "gold-18k-white": "GOLD_18K_WHITE", "gold-18k-rose": "GOLD_18K_ROSE",
  "silver-925": "SILVER_925", "platinum-950": "PLATINUM_950" };
export const PIECES = JSON.parse(readFileSync(join(HERE, "pieces.json"), "utf8"));

const TYPES = { ".js": "text/javascript", ".html": "text/html", ".json": "application/json" };
function serve() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const base = url.pathname.startsWith("/three/") ? THREE : HERE;
    const rel = url.pathname.startsWith("/three/") ? url.pathname.slice("/three/".length) : url.pathname.slice(1) || "index.html";
    const file = normalize(join(base, rel));
    if (!file.startsWith(base)) return res.writeHead(403).end();
    try {
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

async function launch() {
  const require = createRequire(import.meta.url);
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch {
    ({ chromium } = await import("playwright"));
  }
  const server = await serve();
  const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("page:", e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.rendererReady === true, null, { timeout: 60_000 });
  return { browser, page, close: async () => { await browser.close(); server.close(); } };
}

async function contactSheet(browser, shots, file) {
  const html = `<body style="margin:0;background:#0c0c0d;display:grid;grid-template-columns:repeat(5,220px);gap:8px;padding:8px">${shots
    .map((s) => `<figure style="margin:0;color:#ccc;font:11px sans-serif"><img src="${s.url}" width="220" height="220" style="background:#202024"><figcaption>${s.sku}</figcaption></figure>`).join("")}</body>`;
  const sp = await browser.newPage({ viewport: { width: 1180, height: 100 } });
  await sp.setContent(html);
  await sp.screenshot({ path: file, fullPage: true });
}

async function families(dir, sheet) {
  if (!dir) throw new Error("--families needs the folder with one subfolder of GLBs per family (out-<familyId>)");
  const { browser, page, close } = await launch();
  mkdirSync(DESIGN_OUT, { recursive: true });
  const shots = [];
  const art = {};
  const swatch = {};
  for (const [family, glbName] of Object.entries(FAMILY_GLB)) {
    const glb = readFileSync(join(dir, `out-${family}`, glbName)).toString("base64");
    art[family] = {};
    for (const [alloy, metal] of Object.entries(ALLOYS)) {
      const view = family.startsWith("ring") ? "ring" : "front";
      const url = await page.evaluate((spec) => window.renderGlb(spec), { glb, metal, view, size: 640 });
      const name = `${family}.${alloy}.jpg`;
      writeFileSync(join(DESIGN_OUT, name), Buffer.from(url.split(",")[1], "base64"));
      art[family][alloy] = name;
      shots.push({ sku: name, url });
      if (family === "ring.classic") {
        // Small alloy swatch for the material pickers: the same band, transparent background.
        const sw = await page.evaluate((spec) => window.renderGlb(spec), { glb, metal, view, size: 144, background: false });
        writeFileSync(join(DESIGN_OUT, `swatch.${alloy}.png`), Buffer.from(sw.split(",")[1], "base64"));
        swatch[alloy] = `swatch.${alloy}.png`;
      }
    }
    console.log(`${family}: ${Object.keys(ALLOYS).length} alloys`);
  }
  if (sheet) await contactSheet(browser, shots, sheet);
  await close();
  const req = (f) => `require("../../assets/design/${f}")`;
  writeFileSync(DESIGN_MAP, [
    "// GENERATED by tools/jewel-renders/render.mjs --families from the geometry service's GLB_PREVIEW at default",
    "// parameters (real CAD mesh, rendered as an illustration). Do not edit.",
    "export const FAMILY_ART: Readonly<Record<string, Readonly<Record<string, number>>>> = {",
    ...Object.entries(art).map(([f, m]) => `  ${JSON.stringify(f)}: {\n${Object.entries(m).map(([a, n]) => `    ${JSON.stringify(a)}: ${req(n)},`).join("\n")}\n  },`),
    "};",
    "export const ALLOY_SWATCH: Readonly<Record<string, number>> = {",
    ...Object.entries(swatch).map(([a, n]) => `  ${JSON.stringify(a)}: ${req(n)},`),
    "};",
    "",
  ].join("\n"));
  console.log(`wrote ${DESIGN_MAP.slice(ROOT.length + 1)}`);
}

async function main(argv) {
  const famAt = argv.indexOf("--families");
  if (famAt >= 0) return families(argv[famAt + 1], argv.includes("--sheet") ? argv[argv.indexOf("--sheet") + 1] : null);
  const sheetAt = argv.indexOf("--sheet");
  const sheet = sheetAt >= 0 ? argv[sheetAt + 1] : null;
  const only = argv.filter((a, i) => !a.startsWith("--") && i !== sheetAt + 1 || (sheetAt < 0 && !a.startsWith("--")));
  const list = only.length ? PIECES.filter((p) => only.includes(p.sku)) : PIECES;
  const { browser, page, close } = await launch();
  mkdirSync(OUT, { recursive: true });
  const shots = [];
  for (const p of list) {
    const url = await page.evaluate((spec) => window.renderPiece(spec), { piece: p.piece, metal: p.metal, stone: p.stone, view: p.view });
    const buf = Buffer.from(url.split(",")[1], "base64");
    writeFileSync(join(OUT, `${p.sku}.jpg`), buf);
    shots.push({ sku: p.sku, url });
    console.log(`${p.sku}.jpg ${Math.round(buf.length / 1024)} KB`);
  }
  if (sheet) await contactSheet(browser, shots, sheet);
  await close();
  if (!only.length) {
    const lines = PIECES.map((p) => `  ${JSON.stringify(p.sku)}: require("../assets/catalog/${p.sku}.jpg"),`);
    writeFileSync(MAP, [
      "// GENERATED by tools/jewel-renders/render.mjs from tools/jewel-renders/pieces.json. Do not edit.",
      "// Studio renders of the synthetic catalog: 3D illustrations, not photographs or CAD solids.",
      "export const CATALOG_ART: Readonly<Record<string, number>> = {",
      ...lines,
      "};",
      "",
    ].join("\n"));
    console.log(`wrote ${MAP.slice(ROOT.length + 1)}`);
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e);
  process.exit(1);
});
