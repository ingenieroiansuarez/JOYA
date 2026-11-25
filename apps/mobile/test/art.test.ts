import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@jest/globals";
import { FAMILIES, MATERIALS } from "@aurea/design";
import { familyArt, STUDIO_COLOR } from "../src/design/art";
import { ALLOY_SWATCH } from "../src/design/designArt.generated";

describe("design renders", () => {
  it("every family has a render in every alloy, and every alloy a swatch", () => {
    for (const f of FAMILIES) for (const m of MATERIALS) expect(familyArt(f.id, m.id)).toBeDefined();
    for (const m of MATERIALS) expect(ALLOY_SWATCH[m.id]).toBeDefined();
  });

  it("the editor's 3D view uses the same alloy colours as the studio renders", () => {
    const scene = readFileSync(join(__dirname, "../../../tools/jewel-renders/scene.js"), "utf8");
    const key = (id: string) => id.replace(/-/g, "_").toUpperCase().replace(/^GOLD_18K_(\w+)$/, "GOLD_18K_$1");
    for (const m of MATERIALS) {
      const name = key(m.id).replace("SILVER_925", "SILVER_925");
      const hit = new RegExp(`${name}: \\{ color: "(#[0-9a-f]{6})"`).exec(scene);
      expect(hit?.[1]).toBe(STUDIO_COLOR[m.id]);
    }
  });
});
