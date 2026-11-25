export interface Localized { es: string; en: string }
export interface FamilyParameter { name: string; label: Localized; min: number; max: number; default: number; unit: "mm" }
export interface Family { id: string; version: string; category: "ring" | "pendant"; name: Localized; parameters: FamilyParameter[] }
export interface Material {
  id: string;
  metal: string;
  name: Localized;
  purity: string;
  /** Decimal string; nominal reference, not an assay. */
  densityGPerCm3: string;
  densityStatus: "NOMINAL_UNCONFIRMED" | "CONFIGURED";
  previewColor: string;
}
export declare const FAMILIES: Family[];
export declare const MATERIALS_VERSION: string;
export declare const MATERIALS: Material[];
