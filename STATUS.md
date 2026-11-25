# STATUS — AUREA

Hito activo: **000 — Feasibility**. Actualizado: 2026-11-25.
Revisión completa del handoff: https://claude.ai/artifact/MdsS2iw3KGWmf2U3tHW5YS

## Hitos
| Hito | Estado | Nota |
|---|---|---|
| 000 Feasibility | EN CURSO | CAD/DFM con evidencia; Android, AR y mesh IA bloqueados (ver abajo) |
| 100–1000 | NOT_STARTED | No iniciar 100 sin aprobación del gate 000 |

## Backlog 000
| ID | Tarea | Estado | Evidencia |
|---|---|---|---|
| P0-01 | Repo, STATUS, entorno | HECHO | Este archivo; entorno abajo |
| P0-02 | Licencias y versiones, lockfile PoC | PARCIAL | `services/geometry/requirements.lock`, tabla de licencias abajo; falta revisión legal de OCCT/casadi |
| P0-03 | CadQuery anillo y dije, volumen analítico, STEP/STL reimport, fixture DFM pared fina | HECHO (PoC) | `pytest services/geometry` — 29 tests pasan |
| P0-04 | GLB con material y benchmark Filament vs WebView | PARCIAL / BLOQUEADO | GLB m/Y-up generado y verificado; **sin material PBR**; benchmark requiere Android físico |
| P0-05 | AR anillo/arete | BLOQUEADO | Requiere ≥3 Android físicos y consentimiento de participantes |
| P0-06 | Adapter mesh IA simulado / proveedor | NO INICIADO | Proveedor real requiere permiso y credenciales |
| P0-07 | Revisión ADRs, riesgos, go/no-go | PENDIENTE | Tras P0-04/05 |

## Entorno de evidencia (nube, Linux x86_64)
- Python 3.13.18; cadquery 2.8.0; cadquery-ocp 7.9.3.1.1 (OCCT 7.9); trimesh 4.11.1; jsonschema 4.25.1; numpy 2.5.5; pytest 8.4.2.
- Sin dispositivo Android, sin GPU, sin credenciales externas.

## Comandos y resultados
```bash
python -m unittest discover -s 23_SIMULATORS -p "test_*.py" -v   # 23 OK (simulador de referencia, no QA de producto)
pip install -r services/geometry/requirements.lock && pip install --no-deps -e services/geometry
pytest services/geometry                                            # 29 passed
aurea-geometry 09_JEWELRY_ENGINE/fixtures/ring.json services/geometry/out   # DFM REVIEW, vol 447.8654 mm³
```
La PoC original (`10_CAD_AND_GEOMETRY/poc/ring_poc.py`) se re-ejecutó: volúmenes idénticos al `report.json`; STL/GLB mismo hash; STEP hash distinto.

## Hallazgos del hito 000
- **STEP no determinista**: la cabecera lleva timestamp y OCCT nombra el PRODUCT con un contador por proceso. `services/geometry` fija el nombre al id de componente y publica `canonicalSha256` (sección DATA). Usarlo en caché y manifiestos de taller.
- **Estado DFM**: DFM.md exige `REVIEW` cuando falta regla, pero `dfm_report.state` en `core_reference.sql` solo admite PASS/WARN/FAIL. Añadir REVIEW en la migración del hito 100.
- **Vocabulario de parámetros**: canónico = `families.json` (`innerDiameter`, `bandWidth`, `radialThickness`). El simulador usa `diameter/width/thickness`; no copiar ese vocabulario.
- **Ids de componente** se usan como nombres de archivo: se restringen a `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. El schema de diseño debería añadir ese patrón.

## Inconsistencias de contrato a corregir en el hito 100
Detalle en la revisión. Resumen: estados de Payment/Design/Order divergen entre `machines.json`, SQL y OpenAPI; `Job` no expone artefactos; faltan transiciones de diseño, pago simulado/webhook, rechazar cotización, cancelar pedido, custodia recibir/resolver y reclamar borrador invitado; `proposeOperation.operation` sin tipar; `quote` sin columna digest; sobre de eventos duplicado e incompatible; permisos sin rol (`cart.edit`, `logistics.ship`, `notification.read`) y 61 pantallas con permiso ausente en su rol; `check_inventory` expuesto con `catalog.read`.

## Licencias (dependencias del servicio de geometría)
| Paquete | Versión | Licencia declarada | Nota |
|---|---|---|---|
| cadquery | 2.8.0 | Apache-2.0 | |
| cadquery-ocp | 7.9.3.1.1 | Apache-2.0 (bindings) | **Incluye OCCT, LGPL-2.1 con excepción**: revisar obligaciones si se distribuye el binario; uso como servicio backend |
| casadi (transitiva) | 3.8.2 | LGPL-3.0 | Transitiva de cadquery; revisar |
| trimesh | 4.11.1 | MIT | |
| numpy, scipy | 2.5.5 / 1.18.1 | BSD | |
| vtk, trame* (transitivas) | — | BSD / MIT / Apache-2.0 | Peso grande; evaluar si se pueden evitar en la imagen del worker |
| jsonschema, pytest | 4.25.1 / 8.4.2 | MIT | |
Lista completa en `services/geometry/requirements.lock`. No es asesoría legal.

## Bloqueos y decisiones pendientes (ian)
1. Android físico disponible para benchmark de render y AR (modelo/OS).
2. Mercado/país piloto y moneda (condiciona proveedor de pago).
3. Keycloak autogestionado o IdP gestionado.
4. Permiso y presupuesto para evaluar un proveedor de mesh IA (Meshy/Tripo).

## Siguiente
- P0-04: escena de referencia GLB con material PBR y app mínima de benchmark (Filament vs WebView) lista para correr en el dispositivo cuando exista.
- P0-06: adapter de mesh IA simulado con fixture, reparación y escala.
