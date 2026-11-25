import { Controller, Get, Headers, Res } from "@nestjs/common";
import { FAMILIES, MATERIALS } from "@aurea/design";
import { pickLocale } from "../catalog/catalog";
import { Public } from "../public.decorator";

interface LangResponse { setHeader(name: string, value: string): void }

/** listFamilies: what the engine builds, with ranges, and the alloys (catalog.read, public). */
@Controller("geometry/families")
export class FamiliesController {
  @Get()
  @Public()
  list(@Headers("accept-language") acceptLanguage: string | undefined, @Res({ passthrough: true }) res: LangResponse) {
    const lang = pickLocale(acceptLanguage) as "es" | "en";
    res.setHeader("content-language", lang);
    return {
      items: FAMILIES.map((f) => ({
        id: f.id, version: f.version, category: f.category, name: f.name[lang],
        parameters: f.parameters.map((p) => ({ name: p.name, label: p.label[lang], min: p.min, max: p.max, default: p.default, unit: p.unit })),
      })),
      materials: MATERIALS.map((m) => ({
        id: m.id, name: m.name[lang], purity: m.purity, densityGPerCm3: m.densityGPerCm3, densityStatus: m.densityStatus, previewColor: m.previewColor,
      })),
      nextCursor: null,
    };
  }
}
