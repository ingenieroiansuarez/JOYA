# Datos y persistencia
PostgreSQL ACID. UUIDv7 o UUIDv4 consistente; UTC timestamptz, zonas IANA en preferencias. Moneda ISO 4217; NUMERIC(20,6) para cálculos, redondear a escala de moneda al emitir documento. NUMERIC(20,6) para g/ct, mm; cantidades con unidad explícita. 1 ct=0.2 g; 1 troy oz=31.1034768 g. Geometry floats solo en motor, no dinero. Identificador de revisión + digest SHA-256; los archivos usan claves privadas, MIME validado y referencia a versión. PII separada de logs. Política de retención por mercado; eliminación/anonimización no destruye registros legales obligatorios.

## Entidades y ownership
| Módulo | Agregados / atributos esenciales | Invariante |
|---|---|---|
| identity | User, Role, Grant(subject,action,resource,location), Session, Approval | MFA en acciones sensibles; actor != segundo aprobador |
| organization | Organization, Location(kind,parent), WorkCenter, Equipment | una empresa; ubicaciones jerárquicas sin ciclo |
| catalog | Product, SKU, Collection, Media, PriceList | SKU único, publicación versionada |
| materials | Alloy(density,purity), GemSpec(cut, dimensions, origin), Finish | natural/sintética/imitación explícito, origen documentado |
| design | Project(owner), Branch(head), Revision(parent,document,hash), Annotation(component,revision), Share | revisión inmutable y permisos explícitos |
| geometry | FamilyVersion(schema,license,fixtures), Job, Artifact, DfmReport, BOM | resultado ligado a versión de motor y hash de entrada |
| ai | Conversation, Consent, ToolCall, ModelRegistry, UsageLedger | reserva de cuota antes de generación; prompts privados |
| pricing | RateSnapshot, RuleVersion, Estimate, CostLine | snapshot reproducible; no precios vencidos para contratar |
| commerce | Cart, QuoteRevision, QuoteAcceptance, Order, OrderLine | pedido personalizado referencia cotización aceptada |
| payment | PaymentIntent, PaymentEvent, Allocation, Refund | monto/moneda conciliados; idempotencia proveedor |
| inventory | StockLot, GemUnit, Reservation, StockMovement, Balance | lock de lote/gema; append-only; stock no negativo |
| custody | CustodyItem, Transfer, Discrepancy | transferencia requiere entrega/recepción, doble firma cuando aplique |
| procurement | Supplier, RFQ, PurchaseOrder, Receipt, OutsourceJob | recepción parcial no excede cantidad autorizada |
| workshop | WorkOrder, RouteVersion, Task, Dependency, TimeEntry, Consumption, Evidence | no iniciar sin liberación; grafo acíclico |
| quality | Inspection, CheckResult, Nonconformity, Rework, Certificate | no emitir sin aprobación; revocación conserva historial |
| crm | Customer, Lead, Opportunity, Activity, Appointment, CommunicationConsent | acceso por asesor y propósito |
| finance | CostEntry, Receivable, Payable, Reconciliation, ExportBatch | reversión en vez de editar históricos; no contabilidad fiscal propia |
| logistics | Shipment, TrackingEvent, Insurance, DeliveryProof | cobertura y elegibilidad antes de despacho |
| loyalty | Account, PointMovement, Tier, Referral, Reward | ledger y caducidad; evitar duplicados |
| documents | Document, Version, AccessGrant, RetentionPolicy | ACL por expediente, scan antes de disponibilidad |
| audit | AuditEvent, OutboxEvent, InboxEvent, IdempotencyRecord | actor/acción/recurso/correlation; no datos secretos |

## Transacciones
Reserva: lock saldo `FOR UPDATE` o UPDATE condicional; comprobar disponibilidad, insertar reserva y outbox en misma transacción. Gemas únicas: índice parcial para reserva/consumo activo. Expirar bajo mismo lock, reintentar seguro. Custodia: transferir en dos pasos, reconciliar diferencia, no confundir reserva con propiedad. Pago: validar firma, persistir provider event único, consultar estado si ambiguo, aplicar al plan de cuotas dentro de TX; no liberar si importe/moneda no coincide. Aceptar quote: lock, verificar vencimiento y hash, consentimiento, crear pedido + outbox; solicitudes repetidas devuelven mismo pedido. Orden de fabricación: DFM válida para revisión, aprobación profesional, anticipo requerido, stock asignado, tallas confirmadas. Auditoría de cambios críticos y snapshots protegidos con retención y roles separados.

`core_reference.sql` es una migración de referencia para el recorrido inicial, no el esquema completo de los agregados anteriores. Añadir migraciones Drizzle por hito; testear rollback/roll-forward y restauración de copia.
