// WCAG 2.2 relative luminance and contrast ratio (https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio).
const channel = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export function luminance(hex) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) throw new Error(`not a #RRGGBB color: ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(m[1].slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Theme roles resolved to hex. Every role must name a palette or derived color. */
export function resolveThemes(doc) {
  const lookup = (name) => doc.color[name] ?? doc.derivedColor?.[name]?.hex;
  const out = {};
  for (const [theme, roles] of Object.entries(doc.themes)) {
    out[theme] = {};
    for (const [role, name] of Object.entries(roles)) {
      const hex = lookup(name);
      if (!hex) throw new Error(`${theme}.${role}: unknown color ${name}`);
      out[theme][role] = hex;
    }
  }
  return out;
}

/** Every (theme, foreground, background) pair below its rule's minimum. Unrounded: 4.49 fails. */
export function contrastFailures(doc) {
  const themes = resolveThemes(doc);
  const out = [];
  for (const [theme, roles] of Object.entries(themes)) {
    for (const rule of doc.contrast) {
      for (const fg of rule.foreground) {
        for (const bg of rule.background) {
          if (!(fg in roles) || !(bg in roles)) {
            out.push(`${theme}: rule "${rule.rule}" names missing role ${fg in roles ? bg : fg}`);
            continue;
          }
          const r = contrast(roles[fg], roles[bg]);
          if (r < rule.min) out.push(`${theme}: ${fg} on ${bg} = ${r.toFixed(2)} < ${rule.min} (${rule.rule})`);
        }
      }
    }
  }
  return out;
}
