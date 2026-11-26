// AUREA brand mark: a brilliant-cut stone seen from the side (table, crown facets, girdle, pavilion),
// drawn in-house as line art (own artwork, nothing to license) and rendered to the PNGs the app build
// needs. Free and local: headless Chromium (Playwright), no network.
//   node tools/brand/render.mjs            writes apps/mobile/assets/brand/*.png
//   node tools/brand/render.mjs --preview  also writes a contact sheet to the path in $PREVIEW
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const OUT = join(ROOT, "apps/mobile/assets/brand");

// Palette from 18_DESIGN_SYSTEM/tokens.json (dark theme): obsidian ground, champagne → royal gold →
// antique gold for the metal, lit from above like a polished setting.
export const OBSIDIAN = "#0C0C0D";
const GOLD = [["0", "#E5CC96"], ["0.5", "#C5A059"], ["1", "#8A6935"]];

/**
 * A ring with its set stone, in a 100×100 box (60 wide, 65 tall, optically centred): the band is a
 * circle that opens where the stone sits on it, so the two read as one piece of jewellery.
 */
export const MARK = [
  // Band: from one side of the stone's girdle round the bottom to the other.
  "M32 28A30 30 0 1 0 68 28",
  // Stone outline: table, crown, girdle corners, culet.
  "M40 17H60L68 28L50 50L32 28Z",
  // Girdle, crown facets meeting the table, pavilion mains running to the culet.
  "M32 28H68M36 28L40 17L45 28L50 17L55 28L60 17L64 28M36 28L50 50L64 28M45 28L50 50L55 28",
].join("");

function svg({ size, scale, color = "gold", ground = null, stroke = 2.4 }) {
  const paint = color === "gold" ? "url(#metal)" : color;
  const s = (size * scale) / 100; // mark box → canvas
  const off = (size - size * scale) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
  <defs><linearGradient id="metal" x1="0" y1="${off + 17 * s}" x2="0" y2="${off + 82 * s}" gradientUnits="userSpaceOnUse">
    ${GOLD.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join("")}
  </linearGradient></defs>
  ${ground ? `<rect width="${size}" height="${size}" fill="${ground}"/>` : ""}
  <g transform="translate(${off} ${off}) scale(${s})" fill="none" stroke="${paint}" stroke-width="${stroke}"
     stroke-linecap="round" stroke-linejoin="round"><path d="${MARK}"/></g>
</svg>`;
}

// What the build reads (app.json):
//  icon.png              legacy launcher icon, full bleed, ground included
//  adaptive-fg.png       Android adaptive icon foreground: the mark inside the 66/108 safe circle
//  adaptive-mono.png     Android 13+ themed icon: one flat colour, the launcher tints it
//  splash.png            native splash image (transparent, the splash ground comes from app.json)
export const ASSETS = [
  { file: "icon.png", size: 1024, scale: 0.68, ground: OBSIDIAN, stroke: 3 },
  { file: "adaptive-fg.png", size: 1024, scale: 0.66, stroke: 3 },
  { file: "adaptive-mono.png", size: 1024, scale: 0.66, color: "#FFFFFF", stroke: 3.4 },
  { file: "splash.png", size: 600, scale: 1, stroke: 1.8 },
  // In-app cover (src/Cover.tsx) shows the same stone at the same size the splash draws it.
  { file: "mark.png", size: 384, scale: 1, stroke: 1.8 },
];

async function main() {
  const require = createRequire(import.meta.url);
  const { chromium } = require("playwright");
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  for (const a of ASSETS) {
    await page.setContent(`<body style="margin:0;background:transparent">${svg(a)}</body>`);
    await page.locator("svg").screenshot({ path: join(OUT, a.file), omitBackground: !a.ground });
  }
  if (process.argv.includes("--preview") && process.env.PREVIEW) {
    // Contact sheet: the launcher icon under the circle, squircle and rounded-square masks, the themed
    // icon, and the splash, all on the real ground, so the mark is judged where it will be seen.
    const masks = ["50%", "32%", "18%"];
    const tile = (inner, r) => `<div style="width:192px;height:192px;border-radius:${r};overflow:hidden;background:${OBSIDIAN}">${inner}</div>`;
    const fg = svg({ size: 192, scale: 0.66, stroke: 3 });
    const mono = svg({ size: 192, scale: 0.66, color: "#D8E3D0", stroke: 3.4 });
    await page.setViewportSize({ width: 1100, height: 620 });
    await page.setContent(`<body style="margin:0;padding:32px;background:#3a4a40;display:flex;flex-wrap:wrap;gap:32px;align-items:center;font:14px sans-serif;color:#eee">
      ${masks.map((r) => tile(fg, r)).join("")}
      <div style="width:192px;height:192px;border-radius:50%;overflow:hidden;background:#2E3A33">${mono}</div>
      <div style="width:240px;height:480px;background:${OBSIDIAN};display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px">
        ${svg({ size: 112, scale: 1, stroke: 1.8 })}
        <div style="font-family:'Cormorant Garamond',serif;color:#F5F0E6;letter-spacing:10px;font-size:26px">AUREA</div>
      </div>
      ${tile(svg({ size: 48, scale: 0.68, ground: OBSIDIAN, stroke: 3 }).replace('width="48" height="48"', 'width="48" height="48"'), "50%").replace(/192px/g, "48px")}
    </body>`);
    await page.screenshot({ path: process.env.PREVIEW });
  }
  await browser.close();
  console.log(`wrote ${ASSETS.length} brand images to ${OUT.slice(ROOT.length + 1)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e); process.exit(1); });
