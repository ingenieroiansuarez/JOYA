# Hito 000 — Revisión de riesgos, ADRs y recomendación go/no-go (P0-07)
Fecha: 2026-11-25. Autor: equipo de ingeniería (agente). **Decisión: GO condicional aceptado por ian el 2026-11-25** (AR bloqueado, malla IA solo simulada).
Gate del hito (`milestones.csv`): evidencia en dispositivos reales o bloqueo explícito; benchmarks de volumen/tolerancia; ADRs con selección.

## 1. Riesgos del camino crítico (REQ-08-33)
| Riesgo | Evidencia | Estado | Si falla, qué se desactiva |
|---|---|---|---|
| CAD paramétrico (anillo, dije) | `pytest services/geometry` 29 pasan; volumen BREP = fórmula analítica; reimport STEP/STL (DFM-09); fixture de pared fina | **Mitigado (PoC)** | Familias sin generador verificado no se ofrecen en el configurador |
| Exportación reproducible | STEP no determinista en origen; `canonicalSha256` lo resuelve | **Mitigado (PoC)** | Caché y manifiestos usan solo `canonicalSha256` |
| Render 3D en Android | Ambos caminos medidos en Z Flip 7; ADR-0003 aceptado (WebView + Three.js) | **Mitigado en gama alta**; falta gama media y revisión óptica | Propuesta: imagen estática pre-renderizada si un dispositivo no alcanza 30 FPS |
| AR anillo/arete (P0-05) | Ninguna: requiere ≥ 3 Android físicos y ≥ 10 participantes con consentimiento | **Bloqueado** | Virtual Mirror y Smart Fit desactivados; se ofrece modo foto con ajuste manual y visor 3D. La talla nunca se mide por foto sin referencia |
| Malla IA (P0-06) | `pytest services/mesh` 33 pasan con proveedor simulado; reparación, escala explícita, DFM sin PASS | **Parcial**: proveedor real sin evaluar (permiso y credenciales) | Ruta B desactivada fuera de demo; solo ruta A (texto → parámetros → familia). En demo, banner "SIMULADO" |
| Licencias y SBOM (REQ-08-32) | Tabla de licencias en `STATUS.md`; versiones fijadas en lockfiles | **Parcial**: sin SBOM generado; OCCT (LGPL-2.1 con excepción) y casadi (LGPL-3.0) sin revisión legal | No se distribuye el binario del worker CAD fuera del backend hasta la revisión |

## 2. Revisión de ADRs
| ADR | Estado tras 000 | Nota |
|---|---|---|
| 0001 Monolito modular | Dirección, sin PoC | Se valida en hito 100 (bootstrap) |
| 0002 React Native + Expo | Dirección, sin PoC | Compatible con ADR-0003 (WebView); módulo nativo ya no es obligatorio para 3D |
| 0003 Render móvil | **Aceptado con medición** | WebView + Three.js; Filament alternativa |
| 0004 CAD OCCT/CadQuery + Manifold | **Parcial** | OCCT/CadQuery validado; Manifold no probado (sin malla escultórica booleana aún) |
| 0005 PostgreSQL + objetos + Redis + SQLite | Dirección, sin PoC | Hito 100 |
| 0006 REST/OpenAPI + WS | Dirección; **contratos con deriva** | Corregir inconsistencias listadas en `STATUS.md` antes de generar clientes |
| 0007 Outbox + BullMQ | Dirección, sin PoC | Hito 100 |
| 0008 OIDC/Keycloak + RBAC/ABAC | Dirección; **pendiente decisión** Keycloak vs IdP gestionado | Decisión de ian |
| 0009 AI Gateway declarativo | **Parcial** | El contrato del adaptador de malla sigue el patrón; `proposeOperation.operation` sigue sin tipar |
| 0010 AWS referencia, Compose local | Dirección, sin PoC | Hito 100 |
| 0011 Revisiones y conflictos explícitos | Dirección, sin PoC | Hito 300 |
| 0012 Demo → MVP → Profesional | Vigente | |
| 0013 ERP operativo, exportación contable | Dirección; depende de mercado piloto | Decisión de ian (país y moneda) |
| 0014 Licencias y SBOM como gate | **Incumplido parcialmente** | Falta SBOM y revisión legal; añadir SBOM en CI del hito 100 |
| 0015 AR SDK intercambiable | **Sin evidencia** | Bloqueado con P0-05 |

## 3. Recomendación
**GO condicional al hito 100 (Foundation)** para todo lo que no depende de AR ni de un proveedor de malla real:
1. El núcleo CAD, la exportación y el render móvil tienen evidencia suficiente para construir encima.
2. AR (P0-05) sigue **bloqueado**: sus funciones quedan desactivadas en demo y MVP hasta tener la evidencia física. No bloquea el hito 100, que no las usa.
3. La ruta B de malla IA queda solo simulada; activar un proveedor real exige permiso de ian, términos comerciales verificados y credenciales fuera del repo.

Condiciones para el hito 100:
- Corregir la deriva de contratos (estados de Payment/Design/Order, `Job` con artefactos, `proposeOperation` tipado, `REVIEW` en `dfm_report.state`, permisos sin rol) antes de generar código a partir de ellos.
- SBOM generado en CI y revisión legal de OCCT y casadi antes de distribuir binarios.
- Medir el render en un Android de gama media en cuanto haya uno.

## 4. Decisiones abiertas para ian
1. ~~Aceptar o no este go condicional~~: aceptado por ian el 2026-11-25.
2. Mercado/país piloto y moneda.
3. Keycloak autogestionado o IdP gestionado.
4. Permiso y presupuesto para evaluar Meshy/Tripo.
5. Dispositivos y participantes para P0-05 (AR), o aceptar AR fuera del alcance de demo/MVP.
