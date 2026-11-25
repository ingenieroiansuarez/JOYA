// Images of the design families and alloys, rendered from the geometry service's real GLB_PREVIEW at
// default parameters (tools/jewel-renders --families). They show the family and alloy, not the exact
// measurements of a person's design: the editor's 3D view is the design itself.
import { Image, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { alloyColor } from "./describe";
import { ALLOY_SWATCH, FAMILY_ART } from "./designArt.generated";

/**
 * Base colour of each alloy in the studio look (same values as tools/jewel-renders/scene.js METALS),
 * so the editor's 3D view and the catalog renders show the same gold. Falls back to the catalog's
 * preview colour for an alloy added later.
 */
export const STUDIO_COLOR: Readonly<Record<string, string>> = {
  "gold-18k-yellow": "#f1c76b",
  "gold-18k-white": "#dcdbd6",
  "gold-18k-rose": "#eeb497",
  "silver-925": "#ecebe8",
  "platinum-950": "#cfcdc8",
};
export const studioColor = (id: string): string => STUDIO_COLOR[id] ?? alloyColor(id);

/** The alloy as a small rendered band (falls back to a tone dot for an alloy without a render). */
export function AlloySwatch({ id, size = 28 }: { id: string; size?: number }) {
  const src = ALLOY_SWATCH[id];
  if (src === undefined) return <View style={{ width: size / 2, height: size / 2, borderRadius: size / 4, backgroundColor: alloyColor(id) }} />;
  return <Image source={src} style={{ width: size, height: size }} accessibilityIgnoresInvertColors />;
}

export function familyArt(familyId: string, materialId: string): number | undefined {
  return FAMILY_ART[familyId]?.[materialId] ?? FAMILY_ART[familyId]?.["gold-18k-yellow"];
}

/** Square render of a family in an alloy. `label` empty = decorative (the row or card says it). */
export function FamilyArt({ familyId, materialId, label, style }: { familyId: string; materialId: string; label: string; style?: StyleProp<ViewStyle> }) {
  const src = familyArt(familyId, materialId);
  return (
    <View accessible={!!label} accessibilityRole={label ? "image" : undefined} accessibilityLabel={label || undefined}
      importantForAccessibility={label ? "yes" : "no-hide-descendants"} style={[art.frame, style]}>
      {src !== undefined && <Image source={src} style={art.image} resizeMode="cover" />}
    </View>
  );
}

const art = StyleSheet.create({
  frame: { aspectRatio: 1, backgroundColor: "#141416", overflow: "hidden" },
  image: { width: "100%", height: "100%" },
});
