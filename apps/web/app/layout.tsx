import "@aurea/tokens/tokens.css";
import "./globals.css";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { pickLocale, translator } from "../lib/i18n";

export const metadata = { title: "AUREA", robots: { index: false, follow: false } };

const SECTIONS = [
  { key: "home", href: "/", milestone: null },
  { key: "quotes", href: "/panel/cotizaciones", milestone: null },
  { key: "orders", href: "/panel/pedidos", milestone: null },
  { key: "inventory", href: "/panel/inventario", milestone: null },
  { key: "projects", href: null, milestone: "300" },
  { key: "workshop", href: null, milestone: "700" },
] as const;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = pickLocale((await headers()).get("accept-language"));
  const t = translator(locale);
  const env = process.env.AUREA_ENV ?? "local";
  return (
    <html lang={locale} data-theme="dark">
      <body>
        <a className="skip" href="#main">{t("skipToContent")}</a>
        {env !== "production" && <div role="status" className="env-banner">{t("envBanner", { env })}</div>}
        <div className="shell">
          <nav aria-label={t("nav.label")} className="sidebar">
            <p className="brand">{t("brand")}</p>
            <ul>
              {SECTIONS.map((s) =>
                s.milestone ? (
                  <li key={s.key}>
                    <span aria-disabled="true" title={t("home.comingIn", { milestone: s.milestone })}>{t(`nav.${s.key}`)}</span>
                  </li>
                ) : (
                  <li key={s.key}><a href={s.href}>{t(`nav.${s.key}`)}</a></li>
                ),
              )}
            </ul>
          </nav>
          <main id="main" tabIndex={-1}>{children}</main>
        </div>
      </body>
    </html>
  );
}
