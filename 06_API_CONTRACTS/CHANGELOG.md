# Contratos — changelog

## 1.1.0 — 2026-11-25 (hito 100, estados)
Fuente de verdad de estados: `08_STATE_MACHINES/machines.json`. `08_STATE_MACHINES/bindings.json` dice dónde vive cada máquina; `tools/contracts/check_contracts.py` falla en CI si SQL u OpenAPI se desvían.

OpenAPI (1.0.0 → 1.1.0):
- Nuevos esquemas de estado generados de las máquinas: `DesignState`, `QuoteState`, `PaymentState`, `ReservationState`, `WorkOrderState`, `OrderState`, `JobState`, `CertificateState`.
- `Payment`, `Order`, `Reservation`, `WorkOrder`, `Certificate`: `state` pasa de texto libre a su enumeración. `Job` y `Quote` referencian el esquema en vez de repetir la lista.
- `Revision` añade `state` (requerido, `DesignState`). El documento y el digest siguen inmutables; el estado sigue la máquina Design.
- Sigue con texto libre, con nota explícita: `Result.state` (resultado genérico, se reemplaza por esquemas por operación) y `Task.state` (sin máquina aún; taller, hito 700).

SQL de referencia (`core_reference.sql`):
- `payment.state`: añade `PROCESSING`, `PARTIAL_REFUND`, `DISPUTED` (estaban en la máquina, no en la tabla).
- `sales_order.state`: nueva columna, default `PENDING_PAYMENT`.
- `revision.state`: nueva columna (máquina Design), default `DRAFT`.
- `dfm_report.state`: añade `REVIEW` (DFM.md: regla o medición faltante = REVIEW; el servicio de geometría ya lo emite).
- Probado en PostgreSQL 16 con `05_DATABASE/tests/state_checks.sql` (casos positivos y negativos).

Migración: el SQL es de referencia y no hay base desplegada, así que no hay datos que migrar. La primera migración real del backend (hito 100) parte de esta versión. Roll-forward: columnas nuevas con default; los valores añadidos a CHECK amplían el dominio sin invalidar filas existentes.

Pendiente de la revisión del handoff (no incluido aquí): `Job` sin artefactos, transiciones de diseño/pago/pedido sin endpoint, `proposeOperation.operation` sin tipar, `quote` sin digest, sobre de eventos duplicado, permisos sin rol.
