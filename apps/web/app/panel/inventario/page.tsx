import { randomBytes } from "node:crypto";
import { Notice } from "../../../components/Notice";
import { api } from "../../../lib/server/api";
import { can, panelContext } from "../../../lib/server/panel";
import { receiveStock } from "../actions";

export const dynamic = "force-dynamic";

interface Lot { id: string; itemKey: string; label: string; unit: string; location: { name: string }; onHand: string; reserved: string; available: string; held: string; allocated: string; demo: boolean }

export default async function Inventory({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const p = await panelContext("/panel/inventario");
  if (!("me" in p)) return null;
  const { t, locale, me, ctx } = p;
  const sp = await searchParams;
  if (!can(me, "inventory.read")) return <p className="notice">{t("panel.forbidden")}</p>;
  const r = await api<{ items: Lot[] }>(ctx, "GET", "/inventory/lots", { locale });
  if (!r.ok) return <p role="alert" className="notice notice-danger">{t("panel.apiDown", { detail: r.error.message || r.error.code })}</p>;
  const lots = r.body.items;
  return (
    <section aria-labelledby="lots">
      <Notice ok={sp.received ? t("inventory.receivedOk") : undefined} error={sp.error} detail={sp.detail} />
      <h2 id="lots">{t("inventory.title")}</h2>
      {lots.length === 0 ? <p className="empty">{t("inventory.empty")}</p> : (
        <table className="list">
          <thead>
            <tr>
              <th scope="col">{t("inventory.lot")}</th><th scope="col">{t("inventory.location")}</th>
              <th scope="col" className="num">{t("inventory.onHand")}</th><th scope="col" className="num">{t("inventory.held")}</th>
              <th scope="col" className="num">{t("inventory.allocated")}</th><th scope="col" className="num">{t("inventory.available")}</th>
            </tr>
          </thead>
          <tbody>
            {lots.map((l) => (
              <tr key={l.id}>
                <td>{l.label}{l.demo && <> · <span className="badge">{t("inventory.demo")}</span></>}</td>
                <td>{l.location.name}</td>
                <td className="num">{l.onHand} {l.unit}</td><td className="num">{l.held} {l.unit}</td>
                <td className="num">{l.allocated} {l.unit}</td><td className="num"><strong>{l.available} {l.unit}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {lots.length > 0 && can(me, "inventory.move") && (
        <form action={receiveStock} className="stack-form" aria-labelledby="receipt">
          <h2 id="receipt">{t("inventory.receipt")}</h2>
          <input type="hidden" name="idempotencyKey" value={randomBytes(18).toString("base64url")} />
          <label htmlFor="lotId">{t("inventory.lot")}</label>
          <select id="lotId" name="lotId" required>{lots.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}</select>
          <label htmlFor="delta">{t("inventory.quantity")}</label>
          <input id="delta" name="delta" inputMode="decimal" required pattern="\d+([.,]\d{1,6})?" aria-describedby="delta-hint" />
          <p id="delta-hint" className="muted">{t("inventory.quantityHint")}</p>
          <label htmlFor="reason">{t("inventory.reason")}</label>
          <input id="reason" name="reason" required minLength={3} maxLength={200} />
          <button type="submit">{t("inventory.record")}</button>
        </form>
      )}
    </section>
  );
}
