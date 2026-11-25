# Banco de render nativo (P0-04, ruta Filament)

APK de prueba para ADR-0003: misma escena, cámara, giro, escenas (`base`, `vitrina`, `estres`), rampa
(100 → 2500 anillos) y formato de informe que `tools/render-bench` (WebView/Three.js), para comparar las dos rutas
en el mismo teléfono. No es la app de AUREA ni código de producción.

- Filament / gltfio / filament-utils **1.79.0**, AGP 8.7.3, Gradle 8.11.1, Kotlin 2.1.0, minSdk 28, solo `arm64-v8a`.
- Escena: `app/src/main/assets/showcase.glb`, copia exacta de `tools/render-bench/scene/showcase.glb`
  (CI lo comprueba). Se genera desde la salida del servicio de geometría:
  `python tools/render-bench/scene/build_scene.py ring-base.stl tools/render-bench/scene/showcase.glb`.
- Iluminación: entorno procedural (sin HDRI con licencia) prefiltrado con `IBLPrefilterContext`; exposición 1.0.
- Superficie fija de 984×738 px con MSAA 4×, igual que el canvas medido en WebView en el Z Flip 7.
- Tiempos: intervalos entre frames realmente renderizados (`beginFrame() == true`) con timestamps de vsync
  de `Choreographer`; la cadencia de pantalla se calibra con 1,5 s sin renderizar.
- Sin permisos, sin red, sin credenciales. APK firmada con la clave debug de CI: solo para pruebas.

Diferencias conocidas con la ruta web (afectan la comparación visual, no la de rendimiento):
el oro web lleva `clearcoat 0.3`, el GLB no; el tone mapping es el ACES por defecto de cada motor; el entorno
procedural no es idéntico a `RoomEnvironment`.

## Compilar
CI: workflow `Android render bench APK` → artefacto `aurea-render-bench-android-debug` (APK + SHA-256).
Local: `gradle -p apps/render-bench-android assembleDebug` con JDK 17 y Android SDK 35.
