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
| P0-04 | GLB con material y benchmark Filament vs WebView | HECHO (decisión) | Ambos caminos medidos en Z Flip 7; ADR-0003 aceptado: WebView + Three.js. Pendiente revisión óptica humana y gama media |
| P0-05 | AR anillo/arete | BLOQUEADO | Requiere ≥3 Android físicos y consentimiento de participantes |
| P0-06 | Adapter mesh IA simulado / proveedor | PARCIAL | Simulador, importación, escala y reparación hechos (`pytest services/mesh`, 34 tests); evaluación de proveedor real bloqueada: requiere permiso y credenciales |
| P0-07 | Revisión ADRs, riesgos, go/no-go | HECHO | `27_IMPLEMENTATION_ROADMAP/000_GO_NO_GO.md`: GO condicional al hito 100 aceptado por ian (2026-11-25); AR bloqueado |

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

## P0-04 — Render en Android: WebView/Three.js vs Filament nativo
Decisión: **ADR-0003 aceptado el 2026-11-25 por ian**: WebView + Three.js como camino principal; Filament nativo como alternativa documentada.
Dispositivo: Samsung Galaxy Z Flip 7 (SM-F766B, Android 17, GPU Xclipse 950, ANGLE sobre Vulkan), pantalla limitada a 60 Hz. Superficie 984×738 px, MSAA 4× en ambos.

Evidencia:
- `tools/render-bench/results/2026-11-25-zflip7-webview.json` (banco web 0.1.0, sin rampa).
- `tools/render-bench/results/2026-11-25-zflip7-webview-threejs-v0.2.json` (banco web 0.2.0, three r160, sin cargar).
- `tools/render-bench/results/2026-11-25-zflip7-native-filament.json` (APK 0.1.5, Filament 1.79.0, medido cargando).

| | WebView + Three.js (0.2.0) | Filament nativo (0.1.5) |
|---|---|---|
| Base / vitrina / estrés (25 anillos) | 60,1 FPS, p95 16,7 ms | 60,1 FPS, p95 16,7 ms |
| Máximo sostenido en rampa (p95 ≤ 1,1 × cadencia) | 2500 anillos, 5,24 M triángulos, 7500 draw calls | 400 anillos, 435 k triángulos; a 900 p95 33,3 ms |
| Primer cuadro | 301 ms | 584 ms |
| Memoria | 61 MB heap JS (sin GPU ni proceso) | 347 MB PSS del proceso |

Lectura: para la carga real (1 anillo o decenas en vitrina) ambos cumplen el NFR con margen amplio; la web tuvo más techo en esta prueba. Hipótesis no verificada: el ubershader de gltfio y el pipeline HDR limitan a Filament.
Hallazgo: en Filament 1.79.0, destruir `IBLPrefilterContext` tras crear el IBL liberaba la cámara de la vista (SIGSEGV en `FView::computeCameraInfo`); mitigado manteniendo el contexto vivo (APK 0.1.5).
Pendiente: revisión visual humana de oro y gema (calidad óptica no medida objetivamente), medición en un Android de gama media, térmica sostenida. Las escenas no son idénticas (la web dibuja la gema aparte y usa clearcoat).

## P0-06 — Adapter de malla IA (simulado)
Código: `services/mesh` (ver su README). Ruta B: concepto → malla del proveedor → importar, escalar, reparar → DFM → revisión humana.
```bash
pip install -r services/mesh/requirements.lock && pip install --no-deps -e services/mesh
pytest services/mesh                                                # 34 passed
aurea-mesh services/mesh/out --target-mm 24 --confirmed-by joyero   # DFM-01 REVIEW, bbox 24×24×6,22 mm, vol 1674,1519 mm³
```
- El fixture simulado (toroide original con escala sin unidades, Y-up, vértices sin unir, caras invertidas, 2 huecos, triángulos degenerados y duplicados, fragmento suelto) se repara a un volumen cerrado cuyo volumen coincide con el toroide de referencia × factor³ (tolerancia relativa 1e-6). Salidas byte-idénticas entre ejecuciones.
- La escala nunca se adivina: exige una medida en mm confirmada por una persona (`SCALE_REQUIRED` si falta).
- DFM nunca da PASS: DFM-01 es BLOCK si no queda un volumen cerrado y REVIEW si queda (auto-intersecciones no medidas); DFM-02..10 REVIEW. `fabricable: false` siempre.
- Idempotencia por clave, cancelación y reintento sin duplicar cobro; el simulador se rechaza en `production` y cualquier proveedor real devuelve `PROVIDER_NOT_CONFIGURED`.
Pendiente: evaluar Meshy/Tripo (permiso, términos comerciales verificados y credenciales de ian), persistencia de trabajos y ledger de cuota, prueba de auto-intersección.

## Hallazgos del hito 000
- **STEP no determinista**: la cabecera lleva timestamp y OCCT nombra el PRODUCT con un contador por proceso. `services/geometry` fija el nombre al id de componente y publica `canonicalSha256` (sección DATA). Usarlo en caché y manifiestos de taller.
- **Estado DFM**: DFM.md exige `REVIEW` cuando falta regla, pero `dfm_report.state` en `core_reference.sql` solo admite PASS/WARN/FAIL. Añadir REVIEW en la migración del hito 100.
- **Vocabulario de parámetros**: canónico = `families.json` (`innerDiameter`, `bandWidth`, `radialThickness`). El simulador usa `diameter/width/thickness`; no copiar ese vocabulario.
- **Ids de componente** se usan como nombres de archivo: se restringen a `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. El schema de diseño debería añadir ese patrón.

## Inconsistencias de contrato a corregir en el hito 100
Detalle en la revisión. Resumen: estados de Payment/Design/Order divergen entre `machines.json`, SQL y OpenAPI; `Job` no expone artefactos; faltan transiciones de diseño, pago simulado/webhook, rechazar cotización, cancelar pedido, custodia recibir/resolver y reclamar borrador invitado; `proposeOperation.operation` sin tipar; `quote` sin columna digest; sobre de eventos duplicado e incompatible; permisos sin rol (`cart.edit`, `logistics.ship`, `notification.read`) y 61 pantallas con permiso ausente en su rol; `check_inventory` expuesto con `catalog.read`.

Avance (contratos 1.1.0 a 1.5.0, PR #7 a #11 y este): estados alineados, `Job` con artefactos, `DesignOperation` tipado, permisos con rol y alcance, `quote.digest`, un solo sobre de eventos (`event.schema.json` = OpenAPI `Event` = SQL `outbox`), sync y errores tipados (`SyncOperation`, catálogo `errors.json`), endpoints para enviar/aprobar/devolver diseño, rechazar cotización y cancelar pedido. `08_STATE_MACHINES/transitions.json` dice quién dispara cada acción; CI falla si una acción no tiene disparador. Sigue pendiente: endpoint del webhook de pago (depende del proveedor y del mercado piloto, hito 500), custodia (hito 700), reclamar borrador de invitado, esquema de `payload` por tipo de evento y `Revision.document` → esquema de `DesignDocument`.

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
| networkx (services/mesh) | 3.7 | BSD-3-Clause | Requerido por `trimesh.repair.fill_holes` |
Lista completa en `services/geometry/requirements.lock`. No es asesoría legal.

## Bloqueos y decisiones pendientes (ian)
1. Android físico: Z Flip 7 disponible (2026-11-25). Falta un Android de gama media para representatividad.
2. Mercado/país piloto y moneda (condiciona proveedor de pago).
3. Keycloak autogestionado o IdP gestionado.
4. Permiso y presupuesto para evaluar un proveedor de mesh IA (Meshy/Tripo).

## Siguiente
- P0-04: revisión visual del render por ian y medición en un Android de gama media cuando haya uno.
- P0-06: evaluar un proveedor real de malla solo con permiso y credenciales de ian.
