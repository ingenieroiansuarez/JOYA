import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { contrast, contrastFailures, resolveThemes } from "../contrast.mjs";
import tokens from "../tokens.mjs";

const doc = JSON.parse(readFileSync(new URL("../../../18_DESIGN_SYSTEM/tokens.json", import.meta.url), "utf8"));

test("contrast matches the WCAG reference values", () => {
  assert.equal(contrast("#000000", "#FFFFFF").toFixed(2), "21.00");
  assert.equal(contrast("#777777", "#FFFFFF").toFixed(2), "4.48"); // the classic just-failing grey
  assert.equal(contrast("#FFFFFF", "#FFFFFF"), 1);
});

test("every theme pair meets its WCAG 2.2 AA minimum", () => {
  assert.deepEqual(contrastFailures(doc), []);
});

test("the check catches a failing pair", () => {
  // antiqueGold as given in the handoff is 4.45:1 on ivory: just below AA for body text.
  const bad = structuredClone(doc);
  bad.themes.light.accent = "antiqueGold";
  assert.match(contrastFailures(bad).join("\n"), /light: accent on surface = 4\.45 < 4\.5/);
  const missing = structuredClone(doc);
  delete missing.themes.dark.focus;
  assert.match(contrastFailures(missing).join("\n"), /dark: .*missing role focus/);
});

test("both themes define the same roles", () => {
  const themes = resolveThemes(doc);
  assert.deepEqual(Object.keys(themes.light).sort(), Object.keys(themes.dark).sort());
});

const hue = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};
test("derived colors are their source darkened, not new hues", () => {
  for (const [name, d] of Object.entries(doc.derivedColor)) {
    const src = doc.color[d.from];
    assert.ok(src, `${name}: unknown source ${d.from}`);
    assert.ok(Math.abs(hue(src) - hue(d.hex)) < 3, `${name} drifts in hue`);
    assert.ok(contrast(d.hex, "#FFFFFF") > contrast(src, "#FFFFFF"), `${name} is not darker than ${d.from}`);
  }
});

test("touch targets meet the 48 dp rule and the export is frozen", () => {
  assert.ok(tokens.touchTargetDp >= 48);
  assert.ok(Object.isFrozen(tokens));
  assert.equal(tokens.themes.dark.background, doc.color.obsidian);
});
