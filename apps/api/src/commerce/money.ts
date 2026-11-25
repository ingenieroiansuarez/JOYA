// Exact decimal arithmetic for money and weights (CLAUDE.md: Decimal/NUMERIC, never floats).
// A Dec is a bigint scaled by 10^6, the precision of numeric(20,6) in the database.

export const SCALE = 6;
const ONE = 10n ** BigInt(SCALE);
const DEC = /^(-)?(\d+)(?:\.(\d{1,6}))?$/;

export type Dec = bigint & { readonly __dec?: unique symbol };

/** Parse a decimal string ("12.5", "-3", "0.000001"). Anything else throws. */
export function dec(s: string): Dec {
  const m = typeof s === "string" ? DEC.exec(s.trim()) : null;
  if (!m) throw new RangeError(`not a decimal with at most ${SCALE} places: ${String(s)}`);
  const v = BigInt(m[2]) * ONE + BigInt((m[3] ?? "").padEnd(SCALE, "0"));
  return (m[1] ? -v : v) as Dec;
}

export const add = (...xs: Dec[]): Dec => xs.reduce((a, b) => a + b, 0n) as Dec;
export const sub = (a: Dec, b: Dec): Dec => (a - b) as Dec;
/** a × b, rounded half up (away from zero) to 6 places. */
export const mul = (a: Dec, b: Dec): Dec => divRound(a * b, ONE);
/** a ÷ b, rounded half up (away from zero) to 6 places. */
export const div = (a: Dec, b: Dec): Dec => {
  if (b === 0n) throw new RangeError("division by zero");
  return divRound(a * ONE, b);
};

function divRound(n: bigint, d: bigint): Dec {
  const neg = (n < 0n) !== (d < 0n);
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  const q = (an * 2n + ad) / (2n * ad);
  return (neg ? -q : q) as Dec;
}

/** Round half up to a multiple of `step` (e.g. 100 COP), or to `places` decimals when step is omitted. */
export function roundTo(a: Dec, step: Dec): Dec {
  if (step <= 0n) throw new RangeError("step must be positive");
  return (divRound(a, step) * step) as Dec;
}
export const roundPlaces = (a: Dec, places: number): Dec => roundTo(a, (10n ** BigInt(SCALE - places)) as Dec);
/** Round up (towards +∞) to `places` decimals: used for material to reserve, never short. */
export function ceilPlaces(a: Dec, places: number): Dec {
  const step = 10n ** BigInt(SCALE - places);
  const q = a / step;
  return ((q * step < a ? q + 1n : q) * step) as Dec;
}

/** Fixed string with `places` decimals (the value must already be rounded to them). */
export function str(a: Dec, places = SCALE): string {
  const neg = a < 0n;
  const abs = neg ? -a : a;
  const whole = abs / ONE;
  const frac = (abs % ONE).toString().padStart(SCALE, "0");
  if (frac.slice(places).replace(/0/g, "") !== "") throw new RangeError(`value has more than ${places} decimals`);
  return `${neg ? "-" : ""}${whole}${places ? `.${frac.slice(0, places)}` : ""}`;
}

export const cmp = (a: Dec, b: Dec): number => (a < b ? -1 : a > b ? 1 : 0);
export const ZERO = 0n as Dec;
