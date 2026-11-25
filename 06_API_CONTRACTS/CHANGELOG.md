# Contratos — changelog

## 1.4.0 — 2026-11-25 (hito 100, sobre de eventos)
Había tres sobres distintos: `07_DOMAIN_MODELS/event.schema.json` (completo), `Event` de OpenAPI (`type`, `version`; sin `schemaVersion`, `occurredAt`, `correlationId` ni `causationId`) y la tabla `outbox` (las mismas carencias). Ahora hay uno solo: `event.schema.json`. `check_contracts.py` falla en CI si `Event` u `outbox` se desvían de él.

- `Event` (OpenAPI, usado por `syncPull`) se genera del esquema: `eventId`, `eventType`, `schemaVersion`, `aggregateId`, `aggregateVersion`, `occurredAt`, `correlationId`, `causationId` (opcional, puede ser null) y `payload`. No editar a mano (`check_contracts.py --emit`).
- `eventType` en PascalCase (`QuoteAccepted`), 3 a 64 caracteres; `causationId` pasa de texto libre a UUID.
- SQL `outbox`: columnas `event_type`, `schema_version`, `aggregate_version`, `occurred_at`, `correlation_id`, `causation_id`; `payload` debe ser objeto; `UNIQUE(aggregate_id, aggregate_version)` para detectar duplicados y huecos por agregado. Probado en PostgreSQL 16 con `05_DATABASE/tests/outbox_checks.sql` (casos positivos y 5 negativos).

Compatibilidad: cambio incompatible para quien leyera `type`/`version` en `Event`; no hay clientes ni backend todavía. Migración: el SQL es de referencia; la primera migración real parte de esta versión.

Sigue libre (pendiente): `payload` de cada tipo de evento (un esquema por `eventType` cuando se implementen los consumidores), `payload` de sincronización y `Error.details`.

## 1.3.0 — 2026-11-25 (hito 100, transiciones)
Fuente nueva: `08_STATE_MACHINES/transitions.json` asigna a cada acción de cada máquina su disparador: `api` (operación de OpenAPI), `provider-webhook`, `system`, `worker` o `pending` con hito. `check_contracts.py` falla si una acción no tiene entrada, si la operación no existe, no es POST, no exige `Idempotency-Key` o no devuelve el estado de su máquina.

Endpoints nuevos (todos con `Idempotency-Key` y motivo o digest obligatorio):
- `POST /projects/{id}/revisions/{revisionId}/submit` (`submitDesign`, `project.edit`): DRAFT → REVIEW, con `expectedDigest`.
- `POST /projects/{id}/revisions/{revisionId}/approve` (`approveDesign`, `design.approve`): REVIEW → APPROVED. Exige `expectedDigest`, `dfmReportId` y `measurementsConfirmed: true`. El servidor verifica que el DFM sea del mismo digest y sin BLOCK, y que quien aprueba no sea quien envió.
- `POST /projects/{id}/revisions/{revisionId}/return` (`returnDesign`, `design.approve`): REVIEW → DRAFT con motivo.
- `POST /quotes/{id}/reject` (`rejectQuote`, `quote.accept`): ISSUED → REJECTED con `expectedDigest` y motivo.
- `POST /orders/{id}/cancel` (`cancelOrder`, `order.cancel`): PENDING_PAYMENT o CONFIRMED → CANCELLED con motivo. No reembolsa; libera reservas en la misma transacción.

Cambios:
- `refundPayment` devuelve `Payment` (con `PaymentState`) en vez del `Result` genérico.
- Permisos nuevos: `design.approve` (designer, alcance `assigned`; segregación en tiempo de ejecución: aprobador distinto de quien envió) y `order.cancel` (customer `own`, cashier `location`).
- SQL: `quote.digest char(64) NOT NULL` con CHECK hexadecimal; `state_checks.sql` añade el caso negativo.

Sin endpoint, por diseño: confirmar/fallar/disputar un pago llega solo por evento firmado del proveedor o conciliación autorizada (el endpoint del webhook se define con el proveedor, hito 500); vencer y reemplazar cotizaciones, confirmar/avanzar pedidos y reservar/asignar stock son reglas del servidor; las acciones de taller, custodia, logística, servicio, garantía y compras quedan `pending` con su hito.

Compatibilidad: solo añade operaciones; `refundPayment` cambia su respuesta. No hay clientes ni API implementados.

## 1.2.0 — 2026-11-25 (hito 100, trabajos y operaciones)
- `proposeOperation.operation` deja de ser un objeto libre: es `DesignOperation`, un `oneOf` con discriminador `type` generado de las herramientas `PREVIEW` de `13_AI_PROMPTS_AND_TOOLS/tools.json` (`OpCreateRing`, `OpModifyParameter`, ...). Una herramienta `READ`/`CONFIRM` o un tipo desconocido no es una operación válida. La validación semántica (pertenencia, rangos de familia, presupuesto) sigue en el servidor.
- `create_ring` se verifica contra los rangos de `ring.classic` en `families.json`.
- `Job` añade `kind` (`PREVIEW`, `GEOMETRY`, `VALIDATION`, `AI`), `simulated`, `errorCode` y `artifacts` (`JobArtifact`: id, tipo, unidades, SHA-256, bytes). Los artefactos nunca traen URL.
- Nuevo `GET /v1/jobs/{id}/artifacts/{artifactId}` (`getJobArtifact`, `job.read`): devuelve una URL firmada de corta duración con su `expiresAt` y SHA-256.
- El documento se valida como OpenAPI 3.1 en CI (`openapi-spec-validator` 0.9.0, dependencias fijadas en `tools/contracts/requirements.lock`).
- Compatibilidad: cambio incompatible para clientes que enviaban operaciones libres o leían `Job` sin los campos nuevos; no hay clientes ni API implementados todavía.
- Sigue libre (pendiente): `payload` de las operaciones de sincronización offline y `details` de `Error`.

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

Pendiente de la revisión del handoff (no incluido aquí): transiciones de diseño/pago/pedido sin endpoint, `quote` sin digest, sobre de eventos duplicado, permisos sin rol.
