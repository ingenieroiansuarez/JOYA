/** Latest expiry the API accepts for this form, fixed when the form is rendered (with its idempotency key). */
export function expiryCap(validDays: number, now = Date.now()): string {
  const days = Number.isInteger(validDays) && validDays >= 1 && validDays <= 90 ? validDays : 1;
  return new Date(now + days * 86_400_000 - 5 * 60_000).toISOString(); // a few minutes of slack for the round trip
}

/**
 * End of the chosen day in Bogotá, but never past the form's cap: the last allowed day would otherwise
 * overshoot by the hours left until midnight and be refused. Depends only on the form's fields, so a
 * retry of the same form sends the same body and replays under its idempotency key.
 */
export function expiryFor(date: string, cap: string): string {
  const endOfDay = Date.parse(`${date}T23:59:59-05:00`);
  const max = Date.parse(cap);
  return new Date(Number.isNaN(max) ? endOfDay : Math.min(endOfDay, max)).toISOString();
}
