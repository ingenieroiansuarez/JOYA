import type { ReactNode } from "react";
import { AutoRefresh } from "../../components/AutoRefresh";
import { can, panelContext } from "../../lib/server/panel";

export const dynamic = "force-dynamic";

const TABS = [
  { href: "/panel/cotizaciones", key: "quotes", permission: "quote.read" },
  { href: "/panel/pedidos", key: "orders", permission: "order.read" },
  { href: "/panel/inventario", key: "inventory", permission: "inventory.read" },
] as const;

export default async function PanelLayout({ children }: { children: ReactNode }) {
  const p = await panelContext("/panel");
  if ("notConfigured" in p) {
    return (<><h1>{p.t("panel.title")}</h1><p role="alert" className="notice notice-danger">{p.t("panel.notConfigured")}</p></>);
  }
  if ("notStaff" in p) {
    return (
      <>
        <h1>{p.t("panel.title")}</h1>
        <p role="alert" className="notice notice-danger">{p.t("panel.notStaff")}</p>
        <form method="post" action="/auth/logout"><button type="submit" className="button-quiet">{p.t("panel.logout")}</button></form>
      </>
    );
  }
  if ("error" in p) {
    return (<><h1>{p.t("panel.title")}</h1><p role="alert" className="notice notice-danger">{p.t("panel.apiDown", { detail: p.error })}</p></>);
  }
  const { t, me } = p;
  return (
    <>
      <header className="panel-head">
        <div>
          <h1>{t("panel.title")}</h1>
          <p className="muted">{t("panel.signedInAs", { roles: me.roles.filter((r) => r !== "default-roles-aurea").join(", ") || "—" })}</p>
        </div>
        <form method="post" action="/auth/logout"><button type="submit" className="button-quiet">{t("panel.logout")}</button></form>
      </header>
      <nav aria-label={t("panel.tabsLabel")} className="tabs">
        {TABS.filter((x) => can(me, x.permission)).map((x) => <a key={x.key} href={x.href}>{t(`panel.tabs.${x.key}`)}</a>)}
      </nav>
      <AutoRefresh liveLabel={t("panel.live")} offlineLabel={t("panel.offline")} />
      {children}
    </>
  );
}
