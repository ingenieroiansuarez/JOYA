import { family, material, MATERIALS, type DesignDocument, type DesignOperation } from "@aurea/design";
import type { AdapterResult, AiAdapter, GenerateInput, Locale, Note, NoteCode, RawOption } from "./adapter";

/**
 * Deterministic AURA adapter (hito 400). Reads Spanish or English requests with fixed rules and
 * proposes allowlisted operations; it is not a language model and says so (`simulated: true`).
 * Same prompt + same document → same options, which is what the golden set checks.
 */

type Dir = 1 | -1;
interface Want { name: string; dir?: Dir; value?: number; delta?: number }

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ");
const num = (s: string) => Number(s.replace(",", "."));
const NUM = "(\\d+(?:[.,]\\d+)?)";
const fmt = (v: number, locale: Locale) => {
  const r = Math.round(v * 100) / 100;
  return locale === "es" ? String(r).replace(".", ",") : String(r);
};

const PARAMS: Record<string, Record<string, string>> = {
  ring: { bandWidth: "ancho|anchura|width", radialThickness: "grosor|espesor|thickness", innerDiameter: "diametro(?: interior| interno)?|inner diameter|diameter" },
  pendant: { width: "ancho|anchura|width", height: "alto|altura|largo|height|length", thickness: "grosor|espesor|thickness" },
};

/** Small, medium and large steps per parameter (mm). */
const STEP: Record<string, number> = { bandWidth: 0.5, radialThickness: 0.2, innerDiameter: 0.4, width: 2, height: 2, thickness: 0.3 };

const DIRECTIONS: Record<string, [RegExp, Want[]][]> = {
  ring: [
    [/\b(mas ancho|mas anchito|ensanch\w*|wider)\b/, [{ name: "bandWidth", dir: 1 }]],
    [/\b(mas angosto|mas estrecho|menos ancho|narrower)\b/, [{ name: "bandWidth", dir: -1 }]],
    [/\b(mas grueso|mas robusto|mas solido|mas pesado|mas resistente|thicker|sturdier|heavier|stronger)\b/, [{ name: "radialThickness", dir: 1 }]],
    [/\b(mas delgado|mas fino|mas liviano|mas ligero|menos grueso|thinner|lighter)\b/, [{ name: "radialThickness", dir: -1 }]],
    [/\b(talla mas grande|subir (una )?talla|me queda (apretado|justo|pequeno)|size up|too tight)\b/, [{ name: "innerDiameter", dir: 1 }]],
    [/\b(talla mas pequena|bajar (una )?talla|me queda (grande|suelto|flojo)|size down|too loose)\b/, [{ name: "innerDiameter", dir: -1 }]],
    [/\b(delicad[oa]|minimalista|sutil|discret[oa]|delicate|minimal|subtle|dainty|daintier)\b/, [{ name: "bandWidth", dir: -1 }, { name: "radialThickness", dir: -1 }]],
    [/\b(audaz|llamativ[oa]|imponente|statement|bold|bolder|chunky|chunkier)\b/, [{ name: "bandWidth", dir: 1 }, { name: "radialThickness", dir: 1 }]],
  ],
  pendant: [
    [/\b(mas grande|bigger|larger)\b/, [{ name: "width", dir: 1 }, { name: "height", dir: 1 }]],
    [/\b(mas pequen[oa]|mas chic[oa]|smaller)\b/, [{ name: "width", dir: -1 }, { name: "height", dir: -1 }]],
    [/\b(mas alto|mas largo|taller|longer)\b/, [{ name: "height", dir: 1 }]],
    [/\b(mas bajo|mas corto|shorter)\b/, [{ name: "height", dir: -1 }]],
    [/\b(mas ancho|wider)\b/, [{ name: "width", dir: 1 }]],
    [/\b(mas angosto|mas estrecho|narrower)\b/, [{ name: "width", dir: -1 }]],
    [/\b(mas grueso|mas robusto|mas solido|thicker|sturdier)\b/, [{ name: "thickness", dir: 1 }]],
    [/\b(mas delgado|mas fino|mas liviano|mas ligero|thinner|lighter)\b/, [{ name: "thickness", dir: -1 }]],
    [/\b(delicad[oa]|minimalista|sutil|discret[oa]|delicate|minimal|subtle|dainty|daintier)\b/, [{ name: "thickness", dir: -1 }, { name: "width", dir: -1 }, { name: "height", dir: -1 }]],
    [/\b(audaz|llamativ[oa]|imponente|statement|bold|bolder|chunky|chunkier)\b/, [{ name: "thickness", dir: 1 }, { name: "width", dir: 1 }, { name: "height", dir: 1 }]],
  ],
};

const METALS: [RegExp, string][] = [
  [/\b(oro rosa(do)?|rose gold|pink gold)\b/, "gold-18k-rose"],
  [/\b(oro blanco|white gold)\b/, "gold-18k-white"],
  [/\b(oro amarillo|yellow gold)\b/, "gold-18k-yellow"],
  [/\b(platino|platinum)\b/, "platinum-950"],
  [/\b(plata|silver|sterling)\b/, "silver-925"],
];

const T: Record<string, Record<Locale, (...a: string[]) => string>> = {
  subtle: { es: () => "Sutil", en: () => "Subtle" },
  balanced: { es: () => "Equilibrada", en: () => "Balanced" },
  marked: { es: () => "Marcada", en: () => "Bold" },
  exact: { es: () => "Como lo pediste", en: () => "As requested" },
  set: { es: (p, v) => `${p} a ${v} mm`, en: (p, v) => `${p} to ${v} mm` },
  metal: { es: (m) => `en ${m}`, en: (m) => `in ${m}` },
  outOfRange: {
    es: (p, v, lo, hi) => `${p}: pediste ${v} mm y el rango es ${lo}–${hi} mm. No lo ajusto solo.`,
    en: (p, v, lo, hi) => `${p}: you asked for ${v} mm and the range is ${lo}–${hi} mm. I won't adjust it on my own.`,
  },
  limit: {
    es: (p, v) => `${p} ya está en su límite (${v} mm); no puedo ir más allá.`,
    en: (p, v) => `${p} is already at its limit (${v} mm); I can't go further.`,
  },
  ringSize: {
    es: (n, d) => `Tomé la talla ${n} como talla de EE. UU. (≈ ${d} mm de diámetro interior). Confírmala con el joyero.`,
    en: (n, d) => `I read size ${n} as a US ring size (≈ ${d} mm inner diameter). Confirm it with the jeweler.`,
  },
  plainGold: {
    es: () => "Dijiste oro sin color: tomé oro amarillo 18k.",
    en: () => "You said gold without a colour: I used 18k yellow gold.",
  },
  karat: {
    es: () => "Solo hay oro 18k, plata 925 y platino 950; otra ley la confirma el joyero.",
    en: () => "Only 18k gold, 925 silver and 950 platinum are available; any other alloy needs the jeweler.",
  },
  sameMetal: { es: (m) => `La pieza ya es de ${m}.`, en: (m) => `The piece is already ${m}.` },
  ambiguousBig: {
    es: () => "\"Más grande\" en un anillo puede ser talla, ancho o grosor: propongo ancho y grosor. Si es la talla, dime cuál.",
    en: () => "\"Bigger\" on a ring can mean size, width or thickness: I propose width and thickness. If it's the size, tell me which.",
  },
  gems: {
    es: () => "Engastar piedras aún no está en el editor: lo dejo anotado para que un joyero lo revise. No certifico origen ni autenticidad.",
    en: () => "Setting stones isn't in the editor yet: I'll leave it noted for a jeweler. I don't certify origin or authenticity.",
  },
  engraving: { es: () => "El grabado aún no está disponible en el editor.", en: () => "Engraving isn't available in the editor yet." },
  price: {
    es: () => "No doy precios ni costos: la cotización oficial la hace el joyero.",
    en: () => "I don't give prices or costs: the official quote comes from the jeweler.",
  },
  injection: {
    es: () => "Solo propongo cambios de diseño que tú aceptas; ignoré el resto de la instrucción.",
    en: () => "I only propose design changes that you accept; I ignored the rest of the instruction.",
  },
  human: {
    es: () => "Aprobar, fabricar o cobrar lo hace una persona del taller, no AURA.",
    en: () => "Approving, manufacturing or charging is done by a person at the workshop, not AURA.",
  },
  otherKind: {
    es: (k) => `Este diseño es ${k === "ring" ? "un anillo" : "un colgante"}; para otro tipo de pieza crea un diseño nuevo.`,
    en: (k) => `This design is a ${k === "ring" ? "ring" : "pendant"}; for another kind of piece create a new design.`,
  },
  notUnderstood: {
    es: () => "No encontré un cambio concreto. Prueba: \"más ancho\", \"grosor 2 mm\", \"en oro rosa\" o \"talla 7\".",
    en: () => "I didn't find a concrete change. Try: \"wider\", \"thickness 2 mm\", \"in rose gold\" or \"size 7\".",
  },
};

function label(category: string, name: string, locale: Locale, familyId: string): string {
  const p = family(familyId)?.parameters.find((x) => x.name === name);
  return p ? p.label[locale] : name;
}

export function interpret(prompt: string, doc: DesignDocument, locale: Locale, maxOptions: number): AdapterResult {
  const text = ` ${fold(prompt)} `;
  const comp = doc.components[0];
  const fam = family(comp.family)!;
  const category = fam.category;
  const notes: Note[] = [];
  const understood: string[] = [];
  const note = (code: NoteCode, key: string, ...a: string[]) => {
    const message = T[key][locale](...a);
    if (!notes.some((n) => n.message === message)) notes.push({ code, message });
  };
  const range = (name: string) => fam.parameters.find((p) => p.name === name)!;
  const L = (name: string) => label(category, name, locale, comp.family);

  // Instructions that are not design changes: never acted on.
  if (/(ignora|ignore|olvida (tus|las|todas)|system prompt|instrucciones internas|developer mode|actua como|act as|drop table|borra|elimina|delete)/.test(text)) note("IGNORED_INSTRUCTION", "injection");
  if (/\b(aprueba\w*|approve\w*|fabrica(lo|la|r)?|manufactur\w*|cobra\w*|paga\w*|charge|certifica(lo|la)?|certify)\b/.test(text)) note("IGNORED_INSTRUCTION", "human");
  if (/\b(diamante\w*|diamond\w*|esmeralda\w*|emerald\w*|zafiro\w*|sapphire\w*|rubi\w*|ruby|rubies|piedra\w*|gema\w*|gems?|stones?|brillante\w*|moissanit\w*|perla\w*|pearls?)\b/.test(text)) note("NEEDS_JEWELER", "gems");
  if (/\b(grab\w+|engrav\w*|iniciales|initials)\b/.test(text)) note("UNSUPPORTED", "engraving");
  if (/\b(precio|cuanto cuesta|cuanto vale|costo|cost|price|presupuesto|budget)\b/.test(text)) note("NEEDS_JEWELER", "price");
  const otherKind = category === "ring" ? /\b(colgante|dije|pendant|aretes?|earrings?|pulsera|bracelet|collar|necklace)\b/ : /\b(anillo|sortija|ring)\b/;
  if (otherKind.test(text)) note("UNSUPPORTED", "otherKind", category);

  // Explicit values and deltas per parameter.
  const wants: Want[] = [];
  const kw = PARAMS[category];
  const ADJ: [RegExp, string][] = category === "ring"
    ? [[/^(anch|wide|width)/, "bandWidth"], [/^(grues|grosor|thick)/, "radialThickness"]]
    : [[/^(anch|wide|width)/, "width"], [/^(alt|larg|tall|long|height)/, "height"], [/^(grues|grosor|thick)/, "thickness"]];
  for (const m of text.matchAll(new RegExp(`${NUM}\\s*(?:mm|milimetros?)?\\s*(mas|menos|more|less)\\s+(?:de\\s+)?([a-z]+)`, "g"))) {
    const name = ADJ.find(([re]) => re.test(m[3]))?.[1];
    if (name && !wants.some((w) => w.name === name)) wants.push({ name, delta: num(m[1]) * (/menos|less/.test(m[2]) ? -1 : 1) });
  }
  for (const [name, words] of Object.entries(kw)) {
    if (wants.some((w) => w.name === name)) continue;
    const abs = new RegExp(`\\b(?:${words})\\b(?:\\s+(?:de|a|en|of|to|at|=|:))*\\s*${NUM}\\s*(?:mm|milimetros?)?`).exec(text)
      ?? new RegExp(`${NUM}\\s*(?:mm|milimetros?)\\s+(?:de\\s+)?(?:${words})\\b`).exec(text);
    if (abs) wants.push({ name, value: num(abs[1]) });
  }
  if (category === "ring" && !wants.some((w) => w.name === "innerDiameter")) {
    const size = /\b(?:talla|size)\s*(?:us\s*)?(\d{1,2}(?:[.,]5)?)\b/.exec(text);
    if (size) {
      const n = num(size[1]);
      const d = Math.round((11.63 + 0.8128 * n) * 10) / 10;
      note("ASSUMPTION", "ringSize", fmt(n, locale), fmt(d, locale));
      wants.push({ name: "innerDiameter", value: d });
    }
  }
  const explicit = new Set(wants.map((w) => w.name));
  for (const [re, ws] of DIRECTIONS[category]) {
    if (re.test(text)) for (const w of ws) if (!explicit.has(w.name) && !wants.some((x) => x.name === w.name)) wants.push(w);
  }
  if (category === "ring" && /\b(mas grande|bigger|larger)\b/.test(text) && !wants.length) {
    note("ASSUMPTION", "ambiguousBig");
    wants.push({ name: "bandWidth", dir: 1 }, { name: "radialThickness", dir: 1 });
  }

  // Material.
  let materialId: string | null = null;
  for (const [re, id] of METALS) if (re.test(text)) { materialId = id; break; }
  const otherKarat = /\b(10|14|22|24)\s*(k|kt|kilates|quilates|karat)\b/.test(text);
  if (otherKarat) note("UNSUPPORTED", "karat");
  else if (!materialId && /\b(oro|gold)\b/.test(text)) { materialId = "gold-18k-yellow"; note("ASSUMPTION", "plainGold"); }
  const ops0: DesignOperation[] = [];
  if (materialId) {
    const m = material(materialId)!;
    if (m.id === comp.materialId) note("ALREADY_SO", "sameMetal", m.name[locale].toLowerCase());
    else { ops0.push({ type: "change_material", componentId: comp.id, materialId }); understood.push(T.metal[locale](m.name[locale].toLowerCase())); }
  }

  // Fixed values (exact or delta) go into every option; directions vary by step size.
  const current = (name: string) => Number(comp.parameters[name]);
  const fixed: DesignOperation[] = [];
  const dirs: Want[] = [];
  for (const w of wants) {
    const r = range(w.name);
    if (w.dir) { dirs.push(w); continue; }
    const target = Math.round((w.value ?? current(w.name) + (w.delta ?? 0)) * 100) / 100;
    if (target < r.min || target > r.max) {
      note("OUT_OF_RANGE", "outOfRange", L(w.name), fmt(target, locale), fmt(r.min, locale), fmt(r.max, locale));
      continue;
    }
    if (target === current(w.name)) { note("ALREADY_SO", "limit", L(w.name), fmt(target, locale)); continue; }
    fixed.push({ type: "modify_parameter", componentId: comp.id, name: w.name, value: target });
    understood.push(T.set[locale](L(w.name).toLowerCase(), fmt(target, locale)));
  }
  for (const w of dirs) understood.push(`${L(w.name).toLowerCase()} ${w.dir === 1 ? "+" : "−"}`);

  const options: RawOption[] = [];
  const base = [...ops0, ...fixed];
  if (!dirs.length) {
    if (base.length) options.push({ title: T.exact[locale](), summary: understood.join(", "), operations: base, assumptions: [] });
  } else {
    const levels: [string, number][] = [["subtle", 1], ["balanced", 2], ["marked", 3]];
    for (const [key, k] of levels.slice(0, Math.max(1, Math.min(maxOptions, 3)))) {
      const ops: DesignOperation[] = [...base];
      const parts: string[] = [];
      for (const w of dirs) {
        const r = range(w.name);
        const v = Math.round(Math.min(r.max, Math.max(r.min, current(w.name) + w.dir! * STEP[w.name] * k)) * 100) / 100;
        if (v === current(w.name)) continue;
        ops.push({ type: "modify_parameter", componentId: comp.id, name: w.name, value: v });
        parts.push(`${L(w.name).toLowerCase()} ${fmt(current(w.name), locale)} → ${fmt(v, locale)} mm`);
      }
      if (ops.length > base.length || (base.length && !options.length)) {
        options.push({ title: T[key][locale](), summary: [...parts, ...understood.filter((u) => !/[+−]$/.test(u))].join(", "), operations: ops, assumptions: [] });
      }
    }
    for (const w of dirs) {
      const r = range(w.name);
      if (current(w.name) === (w.dir === 1 ? r.max : r.min)) note("OUT_OF_RANGE", "limit", L(w.name), fmt(current(w.name), locale));
    }
  }
  const assumptions = notes.filter((n) => n.code === "ASSUMPTION").map((n) => n.message);
  for (const o of options) o.assumptions = assumptions;
  if (!options.length && !notes.some((n) => n.code !== "ASSUMPTION")) note("NOT_UNDERSTOOD", "notUnderstood");
  return { options, understood, notes };
}

export class SimulatedAdapter implements AiAdapter {
  readonly id = "aura-sim";
  readonly model = "aura-rules-0.1.0";
  readonly simulated = true;
  constructor(private readonly fail: () => "ok" | "down" | "slow" = () => "ok") {}
  capabilities() { return ["CAD_PROPOSAL"] as const; }
  async health() { return this.fail() !== "down"; }
  estimateCost() { return 1; }
  async generate(input: GenerateInput, signal: AbortSignal): Promise<AdapterResult> {
    const mode = this.fail();
    if (mode === "down") throw new Error("simulated outage");
    if (mode === "slow") {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 60_000);
        signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
      });
    }
    return interpret(input.prompt, input.document, input.locale, input.maxOptions);
  }
}

export { MATERIALS };
