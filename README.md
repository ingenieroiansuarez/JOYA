# AUREA — Engineering Handoff V1
**Especificación de ingeniería y kit de arranque · 25 noviembre 2026**

AUREA es una solución exclusiva para una organización joyera, con múltiples ubicaciones. Combina boutique Android, CAD híbrido, AURA IA, comercio, CRM, ERP operativo y taller. No es un marketplace multitenant. La marca comercial es configurable.

## Abrir primero
1. `START_HERE.md` y `CLAUDE.md`.
2. `01_PRODUCT/PRODUCT.md`, `02_REQUIREMENTS/traceability.csv` y `27_IMPLEMENTATION_ROADMAP/ROADMAP.md`.
3. `30_CLAUDE_EXECUTION_PROMPTS/00_FIRST_PROMPT.md` para iniciar el hito 000.
4. `19_SCREEN_INVENTORY/screens.csv`, `18_DESIGN_SYSTEM/tokens.json` y `20_UX_FLOWS/prototype/index.html` (abrir en navegador, sin instalar dependencias).
5. `23_SIMULATORS/README.md` para ejecutar la simulación Python y `24_TESTING/README.md` para pruebas.

## Arranque local (hito 100)
Node 22.23.5 y pnpm 10.28.0 (corepack), Docker. `pnpm install --frozen-lockfile && pnpm bootstrap && docker compose up -d --wait`, luego `pnpm db:migrate`. Detalle y estado en `STATUS.md`.

## Estado y límites
Este ZIP es documentación, contratos, prototipo web y simulador de referencia ejecutable; no contiene una APK compilada, integración de pago real, CAD industrial implementado, activos de joyería comerciales ni infraestructura desplegada. SQL, OpenAPI y configuraciones son bases V1 que deben evolucionar con las migraciones y pruebas del producto. Las 160 familias son especificaciones de trabajo, no modelos fabricables certificados. No ejecutar plantillas en producción sin revisión. Los nombres, pesos, precios, clientes y estados demo son sintéticos. Las decisiones técnicas pendientes se someten a pruebas de concepto antes de fijar versiones de dependencias.
