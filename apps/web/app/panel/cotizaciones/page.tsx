import { randomBytes } from "node:crypto";
import { Notice } from "../../../components/Notice";
import { formatDate, formatMoney, type Money } from "../../../lib/format";
import { api } from "../../../lib/server/api";
import { can, panelContext } from "../../../lib/server/panel";
import { issueQuote } from "../actions";

export const dynamic = "force-dynamic";

interface Line { code: string; label: string; amount: Money }
interface Quote {
  id: string; projectTitle: string; revisionNumber: number; state: string; total: Money; subtotal: Money;
  tax: { code: string; rate: string; amount: Money }; deposit: { rate: string; amount: Money }; lines: Line[];
  bom: { componentId: string; materialId: string; massGrams: string }[];
  pricing: { ruleVersion: string; termsVersion: string; simulated: boolean; ratesSource: string; ratesDate: string };
  digest: string; expiresAt: string; createdAt: string; issuedAt: string | null; orderId: string | null;
  internal?: { costLines: Line[]; cost: Money; margin: string; grossProfit: Money };
}

/** How many days an offer may last, as the API set it on the draft (created → default expiry). */
const validityDays = (q: Quote) => Math.max(1, Math.round((Date.parse(q.expiresAt) - Date.parse(q.createdAt)) / 86_400_000));
const plusDays = (days: number) => new Date(Date.now() + days * 86_400_000).toLocaleDateString("sv-SE", { timeZone: "America/Bogota" });

export default async function Quotes({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const p = await panelContext("/panel/cotizaciones");
  if (!("me" in p)) return null;
  const { t, locale, me, ctx } = p;
  const sp = await searchParams;
  if (!can(me, "quote.read")) return <p className="notice">{t("panel.forbidden")}</p>;
  const [drafts, issued] = await Promise.all([
    api<{ items: Quote[] }>(ctx, "GET", "/quotes?state=DRAFT&limit=50", { locale }),
    api<{ items: Quote[] }>(ctx, "GET", "/quotes?limit=20", { locale }),
  ]);
  if (!drafts.ok || !issued.ok) {
    const e = !drafts.ok ? drafts.error : !issued.ok ? issued.error : null;
    return <p role="alert" className="notice notice-danger">{t("panel.apiDown", { detail: e?.message || e?.code || "" })}</p>;
  }
  const canIssue = can(me, "quote.issue");
  const recent = issued.body.items.filter((q) => q.state !== "DRAFT");
  return (
    <section aria-labelledby="drafts">
      <Notice ok={sp.issued ? t("quotes.issuedOk") : undefined} error={sp.error} detail={sp.detail} />
      <h2 id="drafts">{t("quotes.queue")}</h2>
      {drafts.body.items.length === 0 && <p className="empty">{t("quotes.emptyQueue")}</p>}
      {drafts.body.items.map((q) => (
        <article key={q.id} className="card" aria-labelledby={`q-${q.id}`}>
          <header className="card-head">
            <h3 id={`q-${q.id}`}>{q.projectTitle} · {t("quotes.revision", { n: String(q.revisionNumber) })}</h3>
            <span className="badge">{t(`state.${q.state}`)}</span>
          </header>
          <p className="muted">{t("quotes.requested", { at: formatDate(q.createdAt, locale) })}
            {q.pricing.simulated && <> · <strong className="warn">{t("quotes.simulatedRules", { version: q.pricing.ruleVersion })}</strong></>}</p>
          <div className="cols">
            <table>
              <caption>{t("quotes.customerPrice")}</caption>
              <tbody>
                {q.lines.map((l) => <tr key={l.code}><th scope="row">{l.label}</th><td className="num">{formatMoney(l.amount, locale)}</td></tr>)}
                <tr><th scope="row">{t("quotes.subtotal")}</th><td className="num">{formatMoney(q.subtotal, locale)}</td></tr>
                <tr><th scope="row">{t("quotes.tax", { code: q.tax.code, rate: q.tax.rate })}</th><td className="num">{formatMoney(q.tax.amount, locale)}</td></tr>
                <tr className="total"><th scope="row">{t("quotes.total")}</th><td className="num">{formatMoney(q.total, locale)}</td></tr>
                <tr><th scope="row">{t("quotes.deposit", { rate: q.deposit.rate })}</th><td className="num">{formatMoney(q.deposit.amount, locale)}</td></tr>
              </tbody>
            </table>
            {q.internal && (
              <table>
                <caption>{t("quotes.internal")}</caption>
                <tbody>
                  {q.internal.costLines.map((l) => <tr key={l.code}><th scope="row">{l.label}</th><td className="num">{formatMoney(l.amount, locale)}</td></tr>)}
                  <tr><th scope="row">{t("quotes.cost")}</th><td className="num">{formatMoney(q.internal.cost, locale)}</td></tr>
                  <tr><th scope="row">{t("quotes.margin")}</th><td className="num">{q.internal.margin}</td></tr>
                  <tr className="total"><th scope="row">{t("quotes.grossProfit")}</th><td className="num">{formatMoney(q.internal.grossProfit, locale)}</td></tr>
                </tbody>
              </table>
            )}
          </div>
          <p className="muted">{q.bom.map((b) => `${b.componentId}: ${b.materialId} ${b.massGrams} g`).join(" · ")}</p>
          {canIssue && (
            <form action={issueQuote} className="inline-form">
              <input type="hidden" name="id" value={q.id} />
              <input type="hidden" name="digest" value={q.digest} />
              <input type="hidden" name="amount" value={q.total.amount} />
              <input type="hidden" name="currency" value={q.total.currency} />
              <input type="hidden" name="termsVersion" value={q.pricing.termsVersion} />
              <input type="hidden" name="validDays" value={validityDays(q)} />
              <input type="hidden" name="idempotencyKey" value={randomBytes(18).toString("base64url")} />
              <label htmlFor={`exp-${q.id}`}>{t("quotes.validUntil")}</label>
              <input id={`exp-${q.id}`} name="expiresOn" type="date" required defaultValue={plusDays(validityDays(q))} min={plusDays(1)} max={plusDays(validityDays(q))} />
              <button type="submit">{t("quotes.issue", { total: formatMoney(q.total, locale) })}</button>
            </form>
          )}
        </article>
      ))}
      <h2>{t("quotes.recent")}</h2>
      {recent.length === 0 ? <p className="empty">{t("quotes.emptyRecent")}</p> : (
        <table className="list">
          <thead><tr><th scope="col">{t("quotes.project")}</th><th scope="col">{t("quotes.state")}</th><th scope="col">{t("quotes.total")}</th><th scope="col">{t("quotes.expires")}</th></tr></thead>
          <tbody>
            {recent.map((q) => (
              <tr key={q.id}>
                <td>{q.projectTitle} · {t("quotes.revision", { n: String(q.revisionNumber) })}</td>
                <td><span className="badge">{t(`state.${q.state}`)}</span></td>
                <td className="num">{formatMoney(q.total, locale)}</td>
                <td>{formatDate(q.expiresAt, locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
