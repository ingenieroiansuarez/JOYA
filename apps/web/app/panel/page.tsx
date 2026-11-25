import { redirect } from "next/navigation";
import { can, panelContext } from "../../lib/server/panel";

export const dynamic = "force-dynamic";

/** /panel → the first section this person can use. */
export default async function PanelHome() {
  const p = await panelContext("/panel");
  if (!("me" in p)) return null; // the layout explains what is wrong
  if (can(p.me, "quote.read")) redirect("/panel/cotizaciones");
  if (can(p.me, "order.read")) redirect("/panel/pedidos");
  if (can(p.me, "inventory.read")) redirect("/panel/inventario");
  return <p className="notice">{p.t("panel.noSections")}</p>;
}
