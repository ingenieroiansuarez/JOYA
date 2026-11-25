/**
 * End of the chosen day in Bogotá, but never past what the API allows (now + validity days): the last
 * allowed day would otherwise overshoot by the hours left until midnight and be refused.
 */
export function expiryFor(date: string, validDays: number, now = Date.now()): string {
  const endOfDay = Date.parse(`${date}T23:59:59-05:00`);
  const days = Number.isInteger(validDays) && validDays >= 1 && validDays <= 90 ? validDays : 1;
  const cap = now + days * 86_400_000 - 5 * 60_000; // a few minutes of slack for the round trip
  return new Date(Math.min(endOfDay, cap)).toISOString();
}

