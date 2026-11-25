# STATUS — AUREA

Hito activo: **400** (300 — Jewelry Engine aceptado). Actualizado: 2026-11-25.
Revisión completa del handoff: https://claude.ai/artifact/MdsS2iw3KGWmf2U3tHW5YS

## Hitos
| Hito | Estado | Nota |
|---|---|---|
| 000 Feasibility | GO CONDICIONAL (ian, 2026-11-25) | CAD/DFM y render con evidencia; AR bloqueado y mesh IA solo simulada (`27_IMPLEMENTATION_ROADMAP/000_GO_NO_GO.md`) |
| 100 Foundation | ACEPTADO (ian, 2026-11-25, PR #25) | Gate "arranque limpio, pruebas y login; entorno aislado; sin secretos": CI verde en main, login PKCE real en el Z Flip 7 (debug y release), `.env` fuera de git y `No secrets tracked` en CI. Contratos 1.1–1.7 con verificación en CI; arranque local (pnpm, Compose, migraciones); API con OIDC y permisos por rol; Keycloak local con login PKCE probado. Tokens de diseño con contraste AA verificado. Esqueletos web (Next) y móvil (Expo, login PKCE). Login PKCE real probado en el Z Flip 7 (2026-11-25) |
| 200 Boutique | ACEPTADO (ian, 2026-11-25, PR #30) | Gate "APK dev navega el catálogo; estados vacío/error accesibles": APK debug en el Z Flip 7 navega catálogo, detalle y favoritos contra la API; error "Sin conexión" con Reintentar visto con la API apagada (2026-11-25). Contratos 1.8.0, migración 0001, seed demo, API (PR #26), app (PR #27–#29). Pendiente: recorrido con TalkBack |
| 300 Jewelry Engine | ACEPTADO (ian, 2026-11-25, PR #35) | Gate "parámetro con geometría real; entrada inválida rechazada; reinicio sin conexión; roundtrip STEP/STL": probado en el Z Flip 7 contra API y worker reales (2026-11-25, 12:34–12:50). PR #31–#34 y la de cierre |
| 400–1000 | NOT_STARTED | |

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

## Hito 100 — Arranque local
```
corepack enable            # pnpm 10.28.0 desde packageManager; Node 22.23.5 (.node-version)
pnpm install --frozen-lockfile
pnpm bootstrap             # crea .env (ignorado por git) con contraseñas aleatorias; no las imprime
docker compose up -d --wait   # PostgreSQL 16.15, Valkey 8.1.4 y Keycloak 26.8.1, fijados por digest, solo en 127.0.0.1
pnpm db:migrate             # lee .env
TEST_DATABASE_URL="$DATABASE_URL" pnpm test   # db 3, api 45 (5 contra Keycloak), scripts 5
```
- `pnpm db:migrate` carga `.env` si existe (`node --env-file-if-exists`); un `DATABASE_URL` exportado tiene prioridad.
- Migraciones en `packages/db/migrations` (Drizzle migrator sobre SQL plano, esquema `aurea_migrations`). La prueba crea dos bases nuevas, aplica las migraciones a una y `05_DATABASE/core_reference.sql` a la otra, y exige el mismo catálogo: columnas, restricciones e índices. Una migración alterada hace fallar la prueba (verificado).
- Migrar dos veces no hace nada. Sin `DATABASE_URL` falla cerrado.
- Política: una migración que ya está en main no se edita, se añade otra (CI lo bloquea). Roll-forward: no hay down migrations; un cambio se corrige con una migración nueva compatible. Cada migración actualiza también `core_reference.sql`, del que leen los verificadores de contratos.
- Valkey en lugar de Redis: Redis 7.4+ ya no es BSD (RSALv2/SSPL, AGPL en 8.x). Valkey es BSD-3-Clause, habla el mismo protocolo y BullMQ lo admite. Si se prefiere Redis, es una decisión de licencias.
- `bootstrap` se niega a correr con `AUREA_ENV` distinto de local/ci; `compose.yaml` exige `.env` y falla sin él.
- API (`apps/api`, NestJS 12.6.1 sobre Express, TypeScript 5.9.3): `GET /healthz` (vivo) y `GET /readyz` (PostgreSQL y Valkey con timeout de 2 s, 503 si alguno cae), fuera de `/v1` y sin datos. Todo lo demás exige token (ver Identidad). Los errores siguen el `Error` de OpenAPI con códigos de `errors.json` y `x-correlation-id`, y un fallo no previsto responde `INTERNAL_ERROR` sin filtrar el mensaje. La configuración falla cerrada: faltan variables, entorno desconocido, credenciales ausentes en demo/producción o Valkey sin TLS en producción. `pnpm api:start` la levanta con el `.env` local.
- Licencias: `pnpm license-check` falla si una dependencia npm no es MIT, Apache-2.0, BSD-2/3, ISC o 0BSD (122 paquetes, todos dentro).
- SBOM: `pnpm sbom` escribe `sbom/aurea.cdx.json` (CycloneDX 1.6, determinista, sin fecha): 127 paquetes npm con hash SHA-512 del lockfile y licencia declarada, marcados `required` si se despliegan o `excluded` si son solo de desarrollo; 54 paquetes Python de `services/*/requirements.lock` (sin licencia: no está en el lock y no se adivina; las revisadas están en la tabla de licencias); 3 imágenes de Compose por digest. CI falla si está desfasado frente a los locks, lo valida contra el esquema oficial 1.6 (copiado en `tools/sbom/schema`) y lo publica como artefacto `sbom-cyclonedx`. No cubre aún `apps/render-bench-android` (Gradle, banco de pruebas, no se distribuye).
- Tokens de diseño: `packages/tokens` genera JS, tipos y CSS desde `18_DESIGN_SYSTEM/tokens.json` (1.1.0) y CI comprueba contraste WCAG 2.2 AA de cada par de cada tema (ver DESIGN.md). El tema claro original no cumplía AA en acento, texto secundario y estados; se derivaron variantes más oscuras del mismo tono, aprobadas por ian (2026-11-25). Fuentes aún no empaquetadas (licencia OFL por verificar).
- Web (`apps/web`, Next.js 16.4.6, React 19.3.0, TS 5.9.3): centro de mando con barra lateral, enlace para saltar al contenido, banner de demostración fuera de producción, textos en `messages/es.json` y `en.json` (español por defecto, inglés por `Accept-Language`), tokens por CSS y cabeceras de seguridad (CSP sin `unsafe-eval`, `frame-ancestors 'none'`, sin `x-powered-by`). La prueba compila en modo producción, arranca `next start` y revisa lo que recibe el navegador. Telemetría de Next desactivada. Sin `sharp` (libvips es LGPL-3.0): imágenes sin optimizar. `caniuse-lite` (CC-BY-4.0, datos de compatibilidad del compilador) es una excepción nombrada en `check-licenses.mjs`, pendiente del visto bueno de ian. Pendiente: login web (BFF con cookie de sesión) con el MFA de personal.
- Móvil (`apps/mobile`, Expo SDK 58.0.24, React Native 0.88.1, React 19.3.0): pantalla con tokens, textos ES/EN según el idioma del dispositivo, banner de demostración, estados de carga, error y reintento, y login con Authorization Code + PKCE S256 contra el cliente público `aurea-mobile` (`expo-auth-session` en el navegador del sistema). El access token vive solo en memoria; el refresh token va a SecureStore (Keystore de Android) y se revoca al cerrar sesión. Configuración por `EXPO_PUBLIC_AUREA_ENV`, `EXPO_PUBLIC_OIDC_ISSUER` y `EXPO_PUBLIC_API_URL`, sin valores por defecto; http solo en local/ci. `allowBackup: false`. Pruebas (jest-expo): la URL de autorización lleva `code_challenge` = BASE64URL(SHA-256(verifier)) con S256 y sin secreto (comprobado que falla si se desactiva PKCE), el redirect coincide con el realm y la configuración falla cerrada; además `expo export` compila el bundle Android en cada `pnpm test`. Probado en dispositivo (2026-11-25, Samsung Galaxy Z Flip 7 SM-F766B, Android 17): build debug instalado por USB desde el portátil de ian (Windows), Keycloak y API alcanzados con `adb reverse` (sin cambiar `KC_HOSTNAME`); login de `dev.cliente` en Chrome, vuelta a la app por el redirect y `GET /v1/me` → rol `customer`. Evidencia: captura revisada por ian (no versionada, contiene datos personales). Pasos reproducibles en `apps/mobile/DEVICE.md`. Build release (Hermes, JS embebido, 19.9 MB arm64, firmado con la clave de depuración) probado igual en el Z Flip 7 el mismo día: login → `customer`. Pendiente: firma de distribución y prueba por red local.
- Licencias con la app móvil: se aceptan expresiones SPDX `A OR B` si una alternativa está permitida; se añadieron licencias permisivas MIT-0, BlueOak-1.0.0, Unlicense y Python-2.0; `lightningcss` (MPL-2.0, transformador CSS de Metro, solo de build) es excepción nombrada aprobada por ian el 2026-11-25. El SBOM ahora calcula qué se despliega desde el lockfile.
- Identidad (contratos 1.6.0):
  - Keycloak 26.8.1 (Apache-2.0) en Compose, modo dev, **solo local/CI**. El realm `aurea-local` y el mapa rol→permiso de la API (`apps/api/src/identity/roles.generated.ts`) se generan desde `roles.reference.json` con `node scripts/identity-gen.mjs`; CI falla si están desfasados.
  - Clientes: `aurea-mobile` público, solo Authorization Code con PKCE S256 obligatorio, redirect `com.aurea.customer.dev:/oauthredirect`, sin password grant; `aurea-ci` confidencial, solo client credentials, rol `auditor`; `aurea-api` solo audiencia. Token de acceso de 5 min, refresh rotado.
  - Secretos (`KC_BOOTSTRAP_ADMIN_PASSWORD`, `KC_CI_CLIENT_SECRET`, `KC_DEV_USER_PASSWORD`) aleatorios en `.env`; el realm versionado solo tiene marcadores `${...}`. `pnpm bootstrap` añade a un `.env` existente las claves nuevas sin tocar las que ya tiene.
  - API: `Authorization: Bearer`, firma verificada con las claves del `jwks_uri` del documento de descubrimiento (no atado a Keycloak), `iss` y `aud` exactos, solo RS256/PS256/ES256/EdDSA, 30 s de tolerancia. Token inválido → 401 sin motivo; rol sin el permiso o ruta sin `@RequirePermission` → 403; IdP inalcanzable → 503. Roles desconocidos se ignoran. `OIDC_ISSUER` debe ser https salvo loopback en local/ci.
  - Probado: 9 formas de token malo (sin cabecera, no JWT, vencido, emisor y audiencia ajenos, otra clave, `alg: none`, HS256 con la clave pública, payload alterado) → 401; contra Keycloak real, client credentials → `/v1/me` como auditor, login PKCE de `dev.cliente` → customer, el código no se canjea sin `code_verifier` ni con uno falso, la petición sin `code_challenge` se rechaza y el ID token no sirve contra la API.
  - Pendiente: MFA para personal y step-up (exige pantallas de login de staff, hito 200+), alcance por recurso y ubicación (lo aplica cada módulo cuando exista), revocación/introspección, y desplegar el IdP de producción (Keycloak autogestionado, ADR-0008, decidido el 2026-11-25).
- Probado localmente: compose arriba, migración aplicada, `state_checks.sql` sobre la base migrada OK, Valkey rechaza clientes sin contraseña (`NOAUTH`).

## Hito 300 — Jewelry Engine
Gate: "Parameter update real geometry; rejected invalid input; restart offline; STEP/STL roundtrip".
- Piezas: geometría (familias ring.02 y pendant.02, digest canónico, worker HTTP firmado; PR #31), contratos 1.9.0 + migración 0002 + `packages/design` (PR #32), API de proyectos, vista previa, revisiones, exportación y sync (PR #33), editor móvil con visor WebView + Three.js y cola sin conexión en SQLite (PR #34).
- Prueba en dispositivo (2026-11-25, Z Flip 7 SM-F766B, Android 17, build debug desde main 4bda505 por USB con `adb reverse`; Windows con worker en Python 3.13.6, API y Keycloak locales). Horas locales (UTC−5):
  1. 12:34 — `dev.cliente` crea "Mi diseño" (anillo Clásico, oro 18k): revisión 1 y vista 3D del anillo. El primer trabajo de geometría tardó ~23 s (captura de ian, `step1-after-signin_123458.png`).
  2. 12:35 — Diámetro interior 40: "Fuera de rango: 14–24 mm. No se ajusta solo."; no se puede previsualizar ni guardar (captura de ian).
  3. 12:36 — 19,5 → Previsualizar: volumen 481,795 mm³, peso estimado 7,468 g (densidad nominal sin confirmar), 23,107 × 23,1 × 4,007 mm, pared mínima 1,8 mm, DFM "requiere revisión humana" (captura de ian). Aceptar → revisión 2 (12:36:23, source PREVIEW); el job PREVIEW tardó 4 s.
  4. 12:37 — API detenida (solo el proceso de :3900). Ancho 4 → 4,1 → Guardar sin conexión; app cerrada desde recientes y abierta de nuevo: "Revisión 2 · 1 cambio sin enviar", aviso sin conexión y "Ancho → 4,1 mm · pendiente" (capturas de ian y `step5-before-prende_124818.png`).
  5. 12:48 — API encendida: la app envió el cambio sola → revisión 3 (12:49:03, source SYNC, padre la 2). En la base: una sola `sync_operation` APPLIED, sin CONFLICT/REJECTED, revisiones 1–3 sin duplicados; todos los jobs con 1 intento y `simulated=false`.
  6. 12:50 — Roundtrip de la revisión 3 por la API real (login PKCE de `dev.cliente`): `POST /v1/geometry/jobs` SUCCEEDED; 5 artefactos descargados por URL firmada con SHA-256 igual al de la API y al manifiesto (STEP 9.692 B, STL 50.484 B, GLB, manifiesto, DFM). STEP reimportado con cadquery: 1 sólido válido, volumen 493,8395 mm³ = manifiesto (diferencia relativa 2,2e-14; analítico π/4·(23,1²−19,5²)·4,1 ≈ 493,84), caja 23,1 × 23,1 × 4,1 mm. STL: 1.008 triángulos, cerrado (watertight) y con orientación consistente, volumen 493,635 mm³ (−0,041 % por teselado). Resumen: masa estimada 7,655 g (NOMINAL_UNCONFIRMED), DFM REVIEW, `POC_ONLY_NOT_APPROVED_FOR_MANUFACTURING`, aprobación humana requerida.
  Capturas y archivos en `.data/gate-300/` del portátil de ian (fuera de git).
- Arreglos tras la prueba (PR de cierre): aviso "Generando la vista 3D…" en lugar de "aparece cuando hay conexión" mientras se calcula; `postinstall` genera el visor (el primer bundle falló con `Unable to resolve "./viewer.generated"`); chips de la Boutique que se cortaban en horizontal; el test del límite de memoria del worker se omite en Windows (solo aplica el tiempo; `resource` es POSIX).
- Notas: la caja del manifiesto (23,107 × 23,1 × 4,107) incluye ~0,004 mm de tolerancia de OCC; la reimportación da 23,1 × 23,1 × 4,1. Peso y DFM no autorizan fabricar: densidades nominales sin confirmar y DFM en REVIEW hasta que haya reglas del taller.
- Pendiente: recorrido con TalkBack del editor; prueba en un Android de gama media; settings y gemas (fuera del alcance de 300).

## Hito 200 — Boutique
Gate: "APK dev navega el catálogo; estados vacío/error accesibles".
- Datos: `pnpm db:seed:demo` carga `packages/db/seed/demo-catalog.json` (11 piezas sintéticas en COP: 10 publicadas, 1 borrador; una agotada). Precios, pesos y piedras ficticios, marcados como tales en el archivo y en la app. Se niega con `AUREA_ENV` distinto de local/ci/demo antes de conectar; idempotente. Piedras con origen `LAB_GROWN` para no sugerir gemas naturales.
- API (contratos 1.8.0): `GET /v1/catalog/products` (cursor keyset, `limit`, `category`, `Accept-Language` es/en) y `/{id}`, públicos y solo publicados (borrador = 404). `/v1/me/favorites` GET/PUT/DELETE con `favorite.read`/`favorite.edit` (cliente, alcance `own`, por `sub` del token), idempotentes. Base caída → 503. 19 pruebas contra base migrada y sembrada, respuestas validadas con OpenAPI.
- App (`apps/mobile`): pestañas Boutique, Favoritos y Perfil con pila propia y botón atrás de Android; catálogo en cuadrícula con filtros por categoría, paginación y deslizar para recargar; detalle con metal, peso (g) y piedras (ct) exactos, precio formateado como texto (sin flotantes); favoritos optimistas con reversión; el invitado navega sin cuenta y al guardar se le pide iniciar sesión (REQ-02-01). Sesión restaurada al abrir con el refresh token del Keystore; el access token se renueva al vencer y tras un 401 una sola vez.
- Estados: carga anunciada (región viva), error por tipo (sin conexión / servicio caído / inesperado) con Reintentar y rol `alert`, vacío de categoría con "Ver todas", vacío de favoritos con "Explorar la boutique", pieza retirada con "Volver a la boutique", fallo al cargar más sin perder lo mostrado. Controles ≥ 48 dp con rol y etiqueta. Probado con `@testing-library/react-native` buscando por rol y texto (`test/screens.test.tsx`).
- Imágenes: no hay fotografías ni renders licenciados; las tarjetas usan una ilustración dibujada con vistas en el tono del metal, anunciada como "Ilustración…, no es una fotografía". Fotos o renders reales quedan pendientes (licencia y material de ian).
- Prueba en dispositivo (2026-11-25, Z Flip 7 SM-F766B, Android 17, build debug desde main por USB con `adb reverse`, modo avión): la Boutique carga el catálogo sintético desde la API (capturas), ian recorrió filtros, detalle, guardar como invitado (pide login), login de `dev.cliente` y guardar en favoritos ("Quitar de favoritos" visible) y reportó que pasaron. Hallazgo: la barra de pestañas quedaba bajo los botones de navegación de Android (edge to edge), así que no podía abrir Favoritos; corregido con los insets de `react-native-safe-area-context` 5.11.1 (versión de Expo SDK 58, MIT). Arreglo confirmado en el teléfono (PR #29): la barra queda sobre los botones y Favoritos muestra el Anillo Clásico guardado (captura de ian, 09:03). Estado de error: con la API detenida, al recargar la Boutique aparece "Sin conexión. Revisa tu red e inténtalo de nuevo." con Reintentar y la barra intacta, sin lista vacía (captura de ian, 09:16); la API se reinició y el endpoint de catálogo responde de nuevo; al tocar Reintentar el catálogo vuelve con el favorito intacto (captura de ian, 09:18). Los estados vacíos y la accesibilidad (rol, etiqueta, región viva, alerta) se verificaron con pruebas automáticas; falta recorrerlos con TalkBack en el teléfono.
- Nota de dispositivo: un cable USB defectuoso cortaba ADB cada pocos segundos (y con él los `adb reverse`); con otro cable quedó estable.

## Hallazgos del hito 000
- **STEP no determinista**: la cabecera lleva timestamp y OCCT nombra el PRODUCT con un contador por proceso. `services/geometry` fija el nombre al id de componente y publica `canonicalSha256` (sección DATA). Usarlo en caché y manifiestos de taller.
- **Estado DFM**: DFM.md exige `REVIEW` cuando falta regla, pero `dfm_report.state` en `core_reference.sql` solo admite PASS/WARN/FAIL. Añadir REVIEW en la migración del hito 100.
- **Vocabulario de parámetros**: canónico = `families.json` (`innerDiameter`, `bandWidth`, `radialThickness`). El simulador usa `diameter/width/thickness`; no copiar ese vocabulario.
- **Ids de componente** se usan como nombres de archivo: se restringen a `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`, ya declarado en `design.schema.json` (contratos 1.7.0).

## Inconsistencias de contrato a corregir en el hito 100
Detalle en la revisión. Resumen: estados de Payment/Design/Order divergen entre `machines.json`, SQL y OpenAPI; `Job` no expone artefactos; faltan transiciones de diseño, pago simulado/webhook, rechazar cotización, cancelar pedido, custodia recibir/resolver y reclamar borrador invitado; `proposeOperation.operation` sin tipar; `quote` sin columna digest; sobre de eventos duplicado e incompatible; permisos sin rol (`cart.edit`, `logistics.ship`, `notification.read`) y 61 pantallas con permiso ausente en su rol; `check_inventory` expuesto con `catalog.read`.

Avance (contratos 1.1.0 a 1.5.0, PR #7 a #11 y este): estados alineados, `Job` con artefactos, `DesignOperation` tipado, permisos con rol y alcance, `quote.digest`, un solo sobre de eventos (`event.schema.json` = OpenAPI `Event` = SQL `outbox`), sync y errores tipados (`SyncOperation`, catálogo `errors.json`), endpoints para enviar/aprobar/devolver diseño, rechazar cotización y cancelar pedido. `08_STATE_MACHINES/transitions.json` dice quién dispara cada acción; CI falla si una acción no tiene disparador. Sigue pendiente: endpoint del webhook de pago (depende del proveedor y del mercado piloto, hito 500), custodia (hito 700), reclamar borrador de invitado, y esquema de `payload` por tipo de evento (con su primer productor). `Revision.document` ya referencia `DesignDocument` (contratos 1.7.0).

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
| drizzle-orm (packages/db) | 0.45.4 | Apache-2.0 | Migrador |
| pg y transitivas (packages/db) | 8.23.1 | MIT / ISC | `pnpm licenses list` |
| PostgreSQL (imagen) | 16.15 | PostgreSQL License | Docker oficial, por digest |
| Valkey (imagen) | 8.1.4 | BSD-3-Clause | Docker oficial, por digest |
| Keycloak (imagen) | 26.8.1 | Apache-2.0 | Docker Hub `keycloak/keycloak`, por digest; solo local/CI |
| jose (apps/api) | 6.2.17 | MIT | Verificación JWT/JWKS |
Lista completa en `services/geometry/requirements.lock`. No es asesoría legal.

## Bloqueos y decisiones pendientes (ian)
1. Android físico: Z Flip 7 disponible (2026-11-25). Falta un Android de gama media para representatividad.
2. ~~Mercado/país piloto y moneda~~: Colombia, COP (ian, 2026-11-25; ADR-0013). Queda el proveedor de pagos (hito 500).
3. ~~IdP de producción~~: Keycloak autogestionado (ian, 2026-11-25; ADR-0008).
4. Permiso y presupuesto para evaluar un proveedor de mesh IA (Meshy/Tripo).

## Siguiente
- P0-04: revisión visual del render por ian y medición en un Android de gama media cuando haya uno.
- P0-06: evaluar un proveedor real de malla solo con permiso y credenciales de ian.
