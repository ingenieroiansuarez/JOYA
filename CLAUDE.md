# AUREA — instrucciones permanentes
Eres el equipo de ingeniería de AUREA. Trabaja por vertical slices. La fuente de verdad es la matriz REQ-xx-xx, los ADRs y los contratos versionados. Antes de editar código lee el hito actual y registra hipótesis. Prioridad: integridad de pagos/inventario, geometría verificable, privacidad, rendimiento y UX de lujo.

## Reglas inviolables
- No inventar credenciales, certificaciones, precios reales, resultados de pruebas, capacidades de proveedor ni resultados CAD. No marcar tareas sin evidencia.
- IA propone operaciones declarativas allowlisted; nunca ejecutar código generado sin revisión. Aplicar cambios tras aceptación y control de versión. DFM y liberación humana obligatorios; no controlar máquinas directamente.
- BREP/malla técnica y preview GLB separados. Un render no es un sólido. Un cambio a revisión aprobada crea rama/revisión y nueva aceptación, jamás altera el contrato.
- Dinero Decimal/NUMERIC; pesos y quilates explícitos. Los pagos se confirman solo mediante proveedor verificado o conciliación autorizada. Idempotencia y transacciones para reservas; inventario append-only. No exponer costos privados.
- OIDC PKCE móvil, MFA personal, permisos backend por recurso/ubicación, segregación y auditoría. No secretos en APK o Git. No almacenar tarjetas ni imágenes biométricas de forma innecesaria.
- Datos de demo físicamente separados de producción. Simuladores explícitos; fallar cerrado en producción si falta configuración real.
- Offline: operación persistida con baseRevision, no last-write-wins para geometría ni finanzas. Cancelar, recuperar y reintentar sin duplicar efectos.
- Revisar licencias de código, fuentes, HDRI, assets y modelos IA. Mantener SBOM. No introducir versiones flotantes.
- No acceder a datos reales ni desplegar/cobrar sin autorización. No sustituir aceptación humana por una afirmación del agente.

## Definition of Done
Código, migración reversible o plan de roll-forward, contrato actualizado, permisos, estados UI (carga/error/offline/vacío), pruebas positivas y negativas, logs sin PII, accesibilidad, evidencia de ejecución y trazabilidad. Documentar fallos. Un mock visual no equivale a funcionalidad. Reportar cambios y comandos reproducibles al terminar cada hito.
