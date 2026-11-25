# Banco de render (P0-04, ruta WebView/Three.js)

Página autocontenida que carga `ring-base.glb` (salida de `services/geometry` para el fixture
`09_JEWELRY_ENGINE/fixtures/ring.json`), con oro PBR (metal/roughness) y una gema con transmisión,
sobre un entorno procedural (`RoomEnvironment`, sin HDRI con licencia).
Mide tres escenas de 15 s (2 s de calentamiento): FPS medio, p50/p95/p99 de tiempo de frame,
% de frames > 33 ms, draw calls, tiempo de parseo del GLB, primer frame, GPU y batería si el navegador lo expone.

```bash
python build.py ring-base.glb > index.html   # incrusta el GLB y su SHA-256
```

`three@0.160.0` se carga desde jsDelivr (versión fijada). Los resultados son de la ruta navegador/WebView;
la comparación con Filament nativo requiere una APK de prueba.

Smoke test en la nube (Chromium headless con SwiftShader, GPU por software, escenas de 3 s): carga sin errores,
1008 triángulos, parseo 4,9 ms. Los FPS de ese entorno no son representativos de ningún teléfono.
