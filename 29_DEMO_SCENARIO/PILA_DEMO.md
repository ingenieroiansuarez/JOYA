# Pila demo (hito 600)

Todo corre en el portátil, separado del entorno de desarrollo (ADR-0016). Datos sintéticos, pagos y AURA simulados. No usa ninguna credencial de producción ni servicios pagos.

| Servicio | Desarrollo | Demo |
|---|---|---|
| Archivo de variables | `.env` | `.env.demo` |
| Compose | `compose.yaml` (`aurea-local`) | `compose.demo.yaml` (`aurea-demo`) |
| PostgreSQL | 5432, base `aurea_local` | 5434, base `aurea_demo` |
| Valkey | 6379 | 6381 |
| Keycloak | 8080, realm `aurea-local` | 8180, realm `aurea-demo` |
| Worker de geometría | 3910 | 3911 |
| API | 3900 | 3901 |
| Panel | 3100 | 3101 |
| Artefactos | `.data/artifacts` | `.data/demo/artifacts` |

Las dos pilas pueden estar encendidas a la vez: no comparten puertos, volúmenes ni base.

## Primera vez
```sh
pnpm install --frozen-lockfile
pnpm demo bootstrap          # .env.demo con contraseñas aleatorias (no se muestran)
pnpm demo up                 # PostgreSQL, Valkey y Keycloak del demo
pnpm demo reset --yes        # migraciones + catálogo, stock y gemas sintéticas
```

## Antes de cada presentación
Cuatro terminales (o pestañas):
```sh
pnpm demo up                 # si Docker se reinició
pnpm demo worker             # geometría, 3911 (usa services/geometry/.venv si existe)
pnpm demo api                # API, 3901
pnpm demo web                # panel, http://127.0.0.1:3101 (compila en apps/web/.next-demo)
pnpm demo status             # todo debe decir "ok"
pnpm demo reverse            # con el teléfono por USB: 8180 y 3901
```
Para volver al estado inicial (borra cotizaciones, pedidos y diseños del demo, nada más): `pnpm demo reset --yes`.

## Personas
| Usuario | Roles | Contraseña |
|---|---|---|
| `demo.cliente` | customer | `KC_DEMO_CUSTOMER_PASSWORD` de `.env.demo` |
| `demo.equipo` | advisor, stockkeeper, finance (la que usa quien presenta en el panel) | `KC_DEMO_STAFF_PASSWORD` |
| `demo.asesor`, `demo.disenador`, `demo.almacen`, `demo.inspector` | un rol cada una (segregación) | `KC_DEMO_STAFF_PASSWORD` |

En el teléfono, con el campo de contraseña enfocado: `pnpm demo password` (cliente) o `pnpm demo password --staff`; `--enter` para enviar.

## Dataset sintético
- Catálogo: 11 piezas ficticias en COP (`packages/db/seed/demo-catalog.json`, compartido con desarrollo).
- Stock (`packages/db/seed/demo-stock.json`): "Taller AUREA (demo)", lotes de oro 18k (amarillo, blanco, rosa), plata 925 y platino 950 en gramos; esmeralda y rubí de laboratorio en quilates; gema única `DEMO-GEM-1` (1 unidad). Todo marcado `demo`.
- Precios: `15_COMMERCE_AND_PAYMENTS/pricing.demo.json` (`DEMO_SYNTHETIC`).
