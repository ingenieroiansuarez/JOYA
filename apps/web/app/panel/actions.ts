"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { pickLocale } from "../../lib/i18n";
import { api, requireSession } from "../../lib/server/api";

// Server actions: Next checks the Origin against the host (CSRF), the session cookie is HttpOnly, and
// the API re-checks permission, scope, digest and price on every call. Results go back as query
// params so the pages work without client JavaScript.

const KEY = /^[A-Za-z0-9_-]{16,128}$/;
const field = (f: FormData, k: string) => (typeof f.get(k) === "string" ? (f.get(k) as string).trim() : "");
const back = (path: string, params: Record<string, string>) => redirect(`${path}?${new URLSearchParams(params).toString()}`);

async function ctx(path: string) {
  const s = await requireSession(path);
  if ("notConfigured" in s) redirect(path);
  return { s, locale: pickLocale((await headers()).get("accept-language")) };
}

/** issueQuote: the advisor confirms exactly the price on screen; a changed reprice comes back as PRICE_CHANGED. */
export async function issueQuote(form: FormData): Promise<void> {
  const path = "/panel/cotizaciones";
  const { s, locale } = await ctx(path);
  const id = field(form, "id");
  const key = field(form, "idempotencyKey");
  const date = field(form, "expiresOn");
  if (!/^[0-9a-f-]{36}$/.test(id) || !KEY.test(key) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) back(path, { error: "VALIDATION_FAILED" });
  const r = await api<{ id: string }>(s, "POST", `/quotes/${id}/issue`, {
    locale, idempotencyKey: key,
    body: {
      expectedDigest: field(form, "digest"),
      total: { amount: field(form, "amount"), currency: field(form, "currency") },
      termsVersion: field(form, "termsVersion"),
      expiresAt: `${date}T23:59:59-05:00`, // end of that day in Bogotá
    },
  });
  if (!r.ok) back(path, { error: r.error.code, detail: r.error.message ?? "" });
  back(path, { issued: id });
}

/** recordMovement (RECEIPT): append-only; the API refuses anything that would go below what is reserved. */
export async function receiveStock(form: FormData): Promise<void> {
  const path = "/panel/inventario";
  const { s, locale } = await ctx(path);
  const lotId = field(form, "lotId");
  const delta = field(form, "delta").replace(",", ".");
  const reason = field(form, "reason");
  const key = field(form, "idempotencyKey");
  if (!/^[0-9a-f-]{36}$/.test(lotId) || !/^\d+(\.\d{1,6})?$/.test(delta) || Number(delta) <= 0 || reason.length < 3 || !KEY.test(key)) {
    back(path, { error: "VALIDATION_FAILED" });
  }
  const r = await api<{ onHandAfter: string }>(s, "POST", "/inventory/movements", { locale, idempotencyKey: key, body: { lotId, kind: "RECEIPT", delta, reason } });
  if (!r.ok) back(path, { error: r.error.code, detail: r.error.message ?? "" });
  back(path, { received: lotId });
}
