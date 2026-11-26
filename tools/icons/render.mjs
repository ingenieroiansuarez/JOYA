// Tab bar icons, drawn here (own artwork, no icon font or third-party set to license). Each is a 24×24
// line drawing rendered white on transparent at 1×, 2× and 3× into apps/mobile/assets/icons; the app
// tints them (idle muted, selected gold). Free and local: headless Chromium (Playwright), no network.
//   node tools/icons/render.mjs
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const OUT = join(ROOT, "apps/mobile/assets/icons");
const DP = 24;

export const ICONS = {
  // Brilliant-cut gem seen from the side: table, crown facets and pavilion.
  boutique: `<path d="M6.5 4.5h11L21.5 9.5 12 20.5 2.5 9.5z"/><path d="M2.5 9.5h19M9.5 4.5 7.5 9.5 12 20.5 16.5 9.5 14.5 4.5"/>`,
  // A ring with its set stone: what the customer designs.
  design: `<circle cx="12" cy="14.5" r="6"/><path d="M12 3.5l2.2 2.6L12 8.5 9.8 6.1z"/>`,
  favorites: `<path d="M12 20s-7.5-4.6-9-9.6A4.6 4.6 0 0 1 12 7.2a4.6 4.6 0 0 1 9 3.2C19.5 15.4 12 20 12 20z"/>`,
  // The same heart, filled: the "saved" state on cards and the product page (outline = not saved).
  "favorites-filled": `<path fill="#fff" d="M12 20s-7.5-4.6-9-9.6A4.6 4.6 0 0 1 12 7.2a4.6 4.6 0 0 1 9 3.2C19.5 15.4 12 20 12 20z"/>`,
  // A quote: a folded sheet with its lines and the total underlined (welcome screen; not a tab).
  quote: `<path d="M6.5 3.5h8l4 4v13h-12z"/><path d="M14.5 3.5v4h4M9.5 11h6M9.5 14h6M12.5 17.5h3"/>`,
  profile: `<circle cx="12" cy="8.5" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>`,
};

const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

async function main() {
  const require = createRequire(import.meta.url);
  const { chromium } = require("playwright");
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  for (const scale of [1, 2, 3]) {
    const page = await browser.newPage({ viewport: { width: DP, height: DP }, deviceScaleFactor: scale });
    for (const [name, body] of Object.entries(ICONS)) {
      await page.setContent(`<body style="margin:0;background:transparent">${svg(body)}</body>`);
      const file = join(OUT, `tab-${name}${scale === 1 ? "" : `@${scale}x`}.png`);
      await page.locator("svg").screenshot({ path: file, omitBackground: true });
    }
    await page.close();
  }
  await browser.close();
  console.log(`wrote ${Object.keys(ICONS).length * 3} icons to ${OUT.slice(ROOT.length + 1)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e); process.exit(1); });
