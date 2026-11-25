# Contratos — changelog

## 1.8.0 — 2026-11-25 (hito 200, Boutique)
- Catálogo tipado: `listProducts` devuelve `ProductPage` (`items` de `ProductSummary`, `nextCursor`) en lugar del `Page` libre, con `limit` (1–50, 20 por defecto) y filtro `category`. `getProduct` devuelve `Product` con `sku`, `summary`, `description`, `collection`, `category` (`ProductCategory`), `metal` (`Metal`), `metalWeightGrams` (decimal exacto en gramos), `stones` (`ProductStone`: tipo, cantidad, `totalCarats` decimal exacto, origen) y precio `Money`. Nunca costos.
- Idioma: parámetro común `AcceptLanguage` (es o en, es por defecto); la respuesta lo indica en `Content-Language`.
- Favoritos: `GET /me/favorites` (`favorite.read`), `PUT` y `DELETE /me/favorites/{productId}` (`favorite.edit`), ambos idempotentes con 204. Solo productos publicados. Permisos nuevos para `customer` con alcance `own`; el invitado no los tiene (la app pide iniciar sesión al guardar, REQ-02-01).
- SQL (migración 0001): tablas `product` (publicado si `published_at` no es nulo; precio `numeric(20,6)`, peso `numeric(12,3)`, textos por idioma en `content`) y `favorite` (cliente, producto).

## 1.7.0 — 2026-11-25 (hito 100, documento de diseño)
- `Revision.document` deja de ser un objeto libre: referencia `DesignDocument`, generado de `09_JEWELRY_ENGINE/design.schema.json` (`check_contracts.py --emit`). `check_contracts.py` falla si divergen o si `Revision.document` no lo referencia.
- `design.schema.json` declara ahora reglas que antes solo aplicaba `services/geometry`: al menos un componente, ids de componente con `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` (también son nombres de archivo) y `dependsOn` con ids válidos y sin repetir. El servicio de geometría mantiene sus códigos `EMPTY_DESIGN` e `INVALID_ID` para esos casos.
- `schemaVersion` del documento sigue en `1.0.0`: los documentos válidos antes siguen siéndolo salvo los que el servicio ya rechazaba.

Sigue libre: `payload` de cada tipo de evento (se define con su primer productor/consumidor, para no inventar eventos sin uso), `Page.items`, `Product.publicSummary` y `Customer.consent`.

## 1.6.0 — 2026-11-25 (hito 100, identidad)
- `GET /me` (`getMe`, `x-permission: identity.self`): sujeto, roles y permisos efectivos del llamante tal como los ve la API.
- `Role`: enum con los 16 roles, en el orden de `roles.reference.json`. `check_permissions.py` falla si divergen.
- `identity.self` (alcance `self`) se concede a todos los roles: cada usuario autenticado puede ver su propia identidad.

## 1.5.1 — 2026-11-25 (corrección)
- `SyncOperation.branchId` (UUID) pasa a `branch` (`BranchName`): en SQL una rama se identifica por `(project_id, name)` y no tiene id propio. `createBranch.name` usa el mismo `BranchName` (`^[a-z0-9][a-z0-9._-]{0,63}$`), y SQL `branch.name` tiene el mismo CHECK.

## 1.5.0 — 2026-11-25 (hito 100, sincronización y errores)
Se cierran los dos últimos objetos libres de la revisión del handoff.

Sincronización offline (`syncPush`, 22_OFFLINE_AND_SYNC/SYNC.md):
- Cada operación es un `SyncOperation`: `id`, `projectId`, `branchId`, `baseRevisionId`, `sequence`, `createdAt` y `operation`, que es un `DesignOperation`. Es la misma lista permitida que en línea, así que offline no se puede enviar nada que en línea no sea válido. Desaparecen `type` y `payload` libres.
- `operations` lleva entre 1 y 200 elementos.
- `SyncResult` pasa de `applied` + `conflicts` a `results`, uno por operación y en el mismo orden. Cada resultado es `APPLIED` (con `revisionId`), `CONFLICT` (con `serverRevisionId` y error, sin last-write-wins) o `REJECTED` (con error; el cliente no la reintenta). Antes, una operación rechazada no tenía dónde ir.

Errores:
- Nuevo catálogo `06_API_CONTRACTS/errors.json`, con 43 códigos estables.
  - `use: error`: código de `Error.code`, con su estado HTTP.
  - `use: detail`: código de `ErrorDetail.code`.
- `Error.code` y `Job.errorCode` usan `ErrorCode` (UPPER_SNAKE).
- `Error.details` pasa de objeto libre a una lista de `ErrorDetail`: `code`, `pointer` (JSON Pointer al campo) y `message`. Sin trazas ni PII.
- `check_contracts.py` lee por AST los códigos que lanzan `services/geometry` y `services/mesh`, y falla si alguno falta en el catálogo. También falla si un código se repite, no es UPPER_SNAKE, o si una respuesta de error usa un estado HTTP sin código catalogado.

Compatibilidad: incompatible para quien enviara `type`/`payload` en sync o leyera `applied`/`conflicts`/`details`. No hay clientes todavía.

Sigue libre: `Revision.document`, que debería referenciar el esquema de `DesignDocument`; `Page.items`, que es genérico; `Product.publicSummary` y `Customer.consent`.

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
