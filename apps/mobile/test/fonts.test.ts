// The bundled display face: exact files (hash), their licence text, and the build plugin that embeds
// them must agree, and the app must name only fonts that are embedded (18_DESIGN_SYSTEM: fonts are
// pinned by version and hash, licence recorded).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@jest/globals";
import { fonts } from "../src/ui";

const DIR = join(__dirname, "../assets/fonts");
const manifest = JSON.parse(readFileSync(join(DIR, "FONTS.json"), "utf8")) as { license: string; licenseFile: string; files: Record<string, string> };
const app = JSON.parse(readFileSync(join(__dirname, "../app.json"), "utf8")) as { expo: { plugins: unknown[] } };

describe("bundled fonts", () => {
  it("every font file matches its pinned hash and no unlisted font is shipped", () => {
    const ttf = readdirSync(DIR).filter((f) => /\.(ttf|otf)$/i.test(f)).sort();
    expect(ttf).toEqual(Object.keys(manifest.files).sort());
    for (const [file, sha] of Object.entries(manifest.files)) {
      expect(createHash("sha256").update(readFileSync(join(DIR, file))).digest("hex")).toBe(sha);
    }
  });

  it("ships the SIL Open Font License text with them", () => {
    expect(manifest.license).toBe("OFL-1.1");
    const text = readFileSync(join(DIR, manifest.licenseFile), "utf8");
    expect(text).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/);
    expect(text).toMatch(/Copyright 2015 the Cormorant Project Authors/);
  });

  it("the expo-font plugin embeds exactly those files, and the app names only embedded families", () => {
    const entry = app.expo.plugins.find((p) => Array.isArray(p) && p[0] === "expo-font") as [string, { fonts: string[] }];
    expect(entry[1].fonts.map((f) => f.replace("./assets/fonts/", "")).sort()).toEqual(Object.keys(manifest.files).sort());
    const embedded = new Set(Object.keys(manifest.files).map((f) => f.replace(/\.(ttf|otf)$/i, "")));
    for (const family of [fonts.display, fonts.displayStrong]) expect(embedded.has(family)).toBe(true);
  });
});
