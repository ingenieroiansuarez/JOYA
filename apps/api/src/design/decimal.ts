// Exact decimal arithmetic for weights (CLAUDE.md: no floats for money or weights).
// The CAD volume arrives as a float; it is fixed to 6 decimals once and everything after is exact.

const DEC = /^(\d+)(?:\.(\d+))?$/;

function parse(s: string): { n: bigint; scale: number } {
  const m = DEC.exec(s);
  if (!m) throw new RangeError(`not a non-negative decimal: ${s}`);
  const frac = m[2] ?? "";
  return { n: BigInt(m[1] + frac), scale: frac.length };
}

function format(n: bigint, scale: number): string {
  const s = n.toString().padStart(scale + 1, "0");
  return scale ? `${s.slice(0, -scale)}.${s.slice(-scale)}` : s;
}

/** Round half up to `scale` digits. */
function round(n: bigint, from: number, to: number): bigint {
  if (from <= to) return n * 10n ** BigInt(to - from);
  const div = 10n ** BigInt(from - to);
  return (n + div / 2n) / div;
}

export function fixed(value: number, scale: number): string {
  if (!Number.isFinite(value) || value < 0) throw new RangeError("value must be a finite non-negative number");
  return value.toFixed(scale);
}

/** mass g = volume mm³ × density g/cm³ / 1000, rounded half up to 3 decimals. */
export function massGrams(volumeMm3: number, densityGPerCm3: string): string {
  const v = parse(fixed(volumeMm3, 6));
  const d = parse(densityGPerCm3);
  const product = v.n * d.n; // scale v.scale + d.scale, then / 1000 adds 3
  return format(round(product, v.scale + d.scale + 3, 3), 3);
}
