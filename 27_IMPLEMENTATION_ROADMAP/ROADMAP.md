# Roadmap 000 → 1000
Hitos no son porcentajes ni plazos. Cada fase implementa vertical slices, tests y evidencia. No avanzar si un riesgo bloquea el camino crítico; tareas independientes pueden avanzar con contratos simulados. Requisitos tienen hito de inicio, no finalización automática. Release 600 demo, 800 MVP comercial, 900–1000 visión avanzada. No presupuestos ni cronograma sin equipo, hardware y proveedor confirmados.

## 000 — Feasibility
Dependencias: none.

Trabajo: CAD ring/pendant BREP and mesh roundtrip; Android Filament vs WebView; AR SDK comparison; mesh AI; license inventory.

Gate: Evidence on real devices or explicit blocker; volume/tolerance benchmarks; ADRs with selection.


## 100 — Foundation
Dependencias: 000.

Trabajo: Monorepo, Node/Expo/Next/Python pinned; compose; schema migrations; identity; tokens; CI; baseline contracts.

Gate: Clean bootstrap, test and login; isolated env; no committed secrets.


## 200 — Boutique
Dependencias: 100.

Trabajo: Guest navigation, catalog, product detail, profile, favorite, demo seed.

Gate: APK dev browses catalog; accessible empty/error states.


## 300 — Jewelry Engine
Dependencias: 100,200.

Trabajo: Core ring and pendant families; preview and CAD regeneration; revisions; offline sync; export.

Gate: Parameter update real geometry; rejected invalid input; restart offline; STEP/STL roundtrip.


## 400 — AURA
Dependencias: 300.

Trabajo: Gateway, tool allowlist, deterministic adapter, real optional providers, concepts/mesh jobs.

Gate: Prompt → proposal → authorized revision; failure/quota tests.


## 500 — Commercial slice
Dependencias: 300,400.

Trabajo: Pricing, quote, acceptance, order, simulated deposit, inventory and panel.

Gate: E2E from Android to web, snapshot, duplicate payment and stock tests.


## 600 — Demo Edition
Dependencias: 500.

Trabajo: Signed APK, synthetic dataset, presenter script, optional offline fixture, panel.

Gate: Install physical device; full demo rehearsal; no production credentials.


## 700 — Professional operations
Dependencias: 500,600.

Trabajo: CRM, workshop, inventory/custody, procurement, QA, finance and staff UI.

Gate: Real transactional operations in staging; mass ledger, permission tests.


## 800 — Commercial MVP
Dependencias: 700.

Trabajo: Enable approved market, real payment/insurance/fiscal adapters, AR ring/earring, POS, warranty, security.

Gate: Pilot acceptance, legal/market validation, backup restore, payment reconciliation, physical QA.


## 900 — Professional
Dependencias: 800.

Trabajo: Expand 160 families, surfaces/sculpture, collaboration, marketing, private service, suppliers, gifting, loyalty.

Gate: Every family verified, advanced flows tested, approved licenses.


## 1000 — Complete vision
Dependencias: 900.

Trabajo: Multi-market expansion, automation, equipment, BI, future simulation exploration.

Gate: Market-by-market go-live; operational acceptance; measured SLOs.

## Backlog de primer sprint (000)
P0-01: crear repo y STATUS, documentar hardware/OS y restricciones. P0-02: registrar licencias y versiones candidatas, lockfile PoC. P0-03: CadQuery ring y pendant, fórmula analítica, STEP/STL reimport, DFM thin-wall fixture. P0-04: export preview GLB con material y unit transform, medir escena en Android WebView y Filament; comparar FPS p95, RAM, load, batería, calidad. P0-05: AR anillo/arete PoC, foto fallback, calibración; consentimiento. P0-06: mesh AI adapter sim y evaluación proveedor si autorizado, reparación y escala, sin promesa fabricable. P0-07: revisión ADRs, riesgo/licencia y reporte go/no-go; decidir qué se desactiva si falla. Do not scaffold full app before gates; if physical tests blocked, report pending rather than fabricate evidence.
