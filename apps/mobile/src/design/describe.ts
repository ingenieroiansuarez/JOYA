// Human text for families, alloys, operations and validation issues, in the app's language.
import { family as familyOf, material as materialOf, type Issue } from "@aurea/design";
import { formatDecimal } from "../format";
import type { Locale, translator } from "../i18n";
import type { DesignOperation } from "./types";

type T = ReturnType<typeof translator>;

export const familyName = (id: string, locale: Locale) => familyOf(id)?.name[locale] ?? id;
export const alloyName = (id: string, locale: Locale) => materialOf(id)?.name[locale] ?? id;
export const alloyColor = (id: string) => materialOf(id)?.previewColor ?? "#c9cbd0";
export const mm = (v: number, locale: Locale) => formatDecimal(String(v), "mm", locale);

export function paramLabel(familyId: string, name: string, locale: Locale): string {
  return familyOf(familyId)?.parameters.find((p) => p.name === name)?.label[locale] ?? name;
}

export function describeOp(op: DesignOperation, familyId: string, locale: Locale, t: T): string {
  if (op.type === "modify_parameter") {
    return t("changeParam", { name: paramLabel(familyId, String(op.name), locale), value: mm(Number(op.value), locale) });
  }
  if (op.type === "change_material") return t("changeParam", { name: t("material"), value: alloyName(String(op.materialId), locale) });
  return op.type;
}

export function describeIssue(issue: Issue, familyId: string, name: string, locale: Locale, t: T): string {
  const spec = familyOf(familyId)?.parameters.find((p) => p.name === name);
  const range = spec ? t("range", { min: formatDecimal(String(spec.min), "", locale).trim(), max: formatDecimal(String(spec.max), "", locale).trim() }) : "";
  switch (issue.code) {
    case "OUT_OF_RANGE": return t("issue_OUT_OF_RANGE", { range });
    case "NOT_A_NUMBER": return t("issue_NOT_A_NUMBER");
    case "NOT_FINITE": return t("issue_NOT_FINITE");
    case "NO_CHANGE": return t("issue_NO_CHANGE");
    default: return t("issue_other", { code: issue.code });
  }
}

/** "19,5" or "19.5" → 19.5; anything else → NaN (reported, never guessed). */
export function parseMm(text: string): number {
  const s = text.trim().replace(",", ".");
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : Number.NaN;
}
