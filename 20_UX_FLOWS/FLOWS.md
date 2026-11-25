# Recorridos de referencia y wireframes
## F01 Invitado → diseño → cotización
Home (hero + crear CTA) → intención (Atelier/Genesis/Master) → familia → viewport + controles → estimación (fecha si offline) → guardar (OIDC si invitado) → DFM preliminar → solicitud → pantalla de confirmación. Si red falla, guardar local y reintentar. Si regla no existe, informar revisión requerida. No perder documento al iniciar sesión.
## F02 Genesis → CAD
Prompt, foto/dibujo/voz opcional → brief confirmable → job progress/cancel → 3 conceptos (simulados o reales etiquetados) → selección → CAD proposal o mesh → preview/diff → aplicar a revisión nueva → volver a Atelier. Si proveedor falla conservar prompt y refs; no cobrar doble. Malla inválida permanece referencia.
## F03 Joyero → cliente → producción
Command solicitudes → abrir versión → CAD/DFM → corregir en rama → emitir cotización versionada → cliente compara/acepta → anticipo → stock reservado/asignado → aprobación humana → orden/tareas → QA → certificado → saldo → despacho. Bloqueos: quote expira, stock ocupado, pago pendiente, talla sin confirmar, QC falla. Cada bloqueo tiene acción responsable y registro.
## F04 Boutique/POS
Catálogo → detalle SKU → carrito mixto → confirmar mercado/dirección → checkout → pago → estado → envío. POS: abrir caja, escanear, seleccionar cliente, precio autorizado, pago conciliado, recibo, cierre. No reenviar cobro por refresh.
## F05 AR / Smart Fit
Detalle o proyecto → cámara permiso just-in-time → anillo/arete → calibrar y ajustar → guardar si consentimiento → comparar → confirmar talla por método fiable. Denegación/fallo → foto/manual. Retrato IA solo inspiración.
## F06 Workshop / custodia
Operario inicia sesión → mis tareas → escaneo de orden y material → registrar tiempo/consumo → evidence → entrega/receptor → checklist QA → retrabajo o aprobar. Offline registra tareas permitidas, transfiere custodia crítica online. Conflictos requieren supervisor.
## F07 Cliente posventa
Vault → seleccionar pieza → certificado público verificable → solicitar servicio → recepción e inspección → propuesta → aceptación → trabajo → devolver. Propiedad de cliente nunca se mezcla sin consentimiento.
## Wireframe textual
Customer: [header brand/cart] [hero or viewport] [context actions] [tabs]. Atelier: [back/title/save] [3D viewport, zoom/rotate] [parameters / materials / components] [estimate & CTA]. Command: [sidebar] [filters] [KPI/table/detail drawer]. Master: [toolbar] [tree | viewport | inspector] [history & DFM]. Workshop: [assigned task] [large scan] [time/evidence] [next]. POS: [search / products | cart / customer / payment]. Supplier: [assigned jobs] [limited docs & evidence].
Prototype HTML runs only locally in one browser, synthetic local state. It intentionally does not mimic AR or an AI provider; those are specified in separate docs. Use it as direction, not as production code.
