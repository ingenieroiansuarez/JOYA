import { formatDate, formatMoney, type Money } from "../../../lib/format";
import { api } from "../../../lib/server/api";
import { can, panelContext } from "../../../lib/server/panel";

export const dynamic = "force-dynamic";

interface Order {
  id: string; projectTitle: string; revisionNumber: number; state: string; total: Money;
  deposit: { required: Money; paid: Money; outstanding: Money }; balance: Money;
  reservations: { id: string; itemKey: string; lotLabel: string; unit: string; quantity: string; state: string; expiresAt: string }[];
  payments: { id: string; kind: string; amount: Money; state: string; provider: { id: string; simulated: boolean }; reviewReason?: string | null; failureCode?: string | null }[];
  cancelReason: string | null; createdAt: string;
}

export default async function Orders() {
  const p = await panelContext("/panel/pedidos");
  if (!("me" in p)) return null;
  const { t, locale, me, ctx } = p;
  if (!can(me, "order.read")) return <p className="notice">{t("panel.forbidden")}</p>;
  const r = await api<{ items: Order[] }>(ctx, "GET", "/orders?limit=50", { locale });
  if (!r.ok) return <p role="alert" className="notice notice-danger">{t("panel.apiDown", { detail: r.error.message || r.error.code })}</p>;
  if (r.body.items.length === 0) return <p className="empty">{t("orders.empty")}</p>;
  return (
    <section aria-label={t("panel.tabs.orders")}>
      {r.body.items.map((o) => (
        <article key={o.id} className="card" aria-labelledby={`o-${o.id}`}>
          <header className="card-head">
            <h3 id={`o-${o.id}`}>{o.projectTitle} · {t("quotes.revision", { n: String(o.revisionNumber) })}</h3>
            <span className={`badge badge-${o.state.toLowerCase()}`}>{t(`state.${o.state}`)}</span>
          </header>
          <p className="muted">{t("orders.created", { at: formatDate(o.createdAt, locale) })}{o.cancelReason ? ` · ${o.cancelReason}` : ""}</p>
          <dl className="facts">
            <div><dt>{t("quotes.total")}</dt><dd>{formatMoney(o.total, locale)}</dd></div>
            <div><dt>{t("orders.depositRequired")}</dt><dd>{formatMoney(o.deposit.required, locale)}</dd></div>
            <div><dt>{t("orders.depositPaid")}</dt><dd>{formatMoney(o.deposit.paid, locale)}</dd></div>
            <div><dt>{t("orders.outstanding")}</dt><dd>{formatMoney(o.deposit.outstanding, locale)}</dd></div>
            <div><dt>{t("orders.balance")}</dt><dd>{formatMoney(o.balance, locale)}</dd></div>
          </dl>
          <h4>{t("orders.reservations")}</h4>
          {o.reservations.length === 0 ? <p className="empty">{t("orders.noReservations")}</p> : (
            <ul>
              {o.reservations.map((v) => (
                <li key={v.id}>{v.lotLabel}: {v.quantity} {v.unit} · {t(`state.${v.state}`)}{v.state === "HELD" ? ` · ${t("orders.until", { at: formatDate(v.expiresAt, locale) })}` : ""}</li>
              ))}
            </ul>
          )}
          <h4>{t("orders.payments")}</h4>
          {o.payments.length === 0 ? <p className="empty">{t("orders.noPayments")}</p> : (
            <ul>
              {o.payments.map((x) => (
                <li key={x.id}>
                  {t(`orders.kind.${x.kind}`)} {formatMoney(x.amount, locale)} · {t(`state.${x.state}`)}
                  {x.provider.simulated && <> · <strong className="warn">{t("orders.simulated")}</strong></>}
                  {x.reviewReason && <> · <strong className="danger">{t("orders.review", { reason: x.reviewReason })}</strong></>}
                  {x.failureCode && <> · {x.failureCode}</>}
                </li>
              ))}
            </ul>
          )}
        </article>
      ))}
    </section>
  );
}
