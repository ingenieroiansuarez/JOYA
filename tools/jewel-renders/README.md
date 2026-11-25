# Renders de joyas (UI de la app)

Imágenes de estudio para la app móvil, hechas aquí mismo, gratis y sin red: three.js (MIT, de `apps/mobile/node_modules`) en Chromium sin pantalla (Playwright). La iluminación es `RoomEnvironment` de three.js, procedural, así que no hay HDRI ni fotos con licencia de terceros.

- **Catálogo** (`pieces.json` → `apps/mobile/assets/catalog/<SKU>.jpg`, `src/catalogArt.generated.ts`): cada pieza sintética del catálogo construida con primitivas en milímetros (banda media caña, solitario de cuatro garras, bisel de esmeralda, media alianza, medalla, gota con bisel, argollas, topos, esclava martillada, cadena veneciana). Son **ilustraciones 3D**, no fotografías ni sólidos CAD: la app las anuncia así.
- **Familias del diseñador** (`--families` → `apps/mobile/assets/design/`, `src/design/designArt.generated.ts`): la malla `GLB_PREVIEW` real del servicio de geometría (CadQuery) de cada familia con sus parámetros por defecto, en los cinco metales, más una muestra pequeña de cada metal para los selectores. Muestran la familia y el metal, no las medidas exactas de un diseño: eso lo muestra el visor 3D del editor.

El visor 3D del editor (`apps/mobile/src/design/viewer/viewer.js`) usa la misma luz, tono y colores de metal (`STUDIO_COLOR` en `apps/mobile/src/design/art.tsx`, comprobado contra `METALS` de `scene.js` en `test/art.test.ts`).

## Regenerar
```sh
pnpm install --frozen-lockfile
node tools/jewel-renders/render.mjs --sheet /tmp/catalogo.png          # catálogo + hoja de revisión

# Familias: primero las GLB reales con el servicio de geometría (Python 3.13, services/geometry)
for f in ring.classic ring.02 pendant.01 pendant.02; do
  # documento con la familia y sus parámetros por defecto (09_JEWELRY_ENGINE/fixtures/ring.json como base)
  aurea-geometry <doc-$f>.json <dir>/out-$f
done
node tools/jewel-renders/render.mjs --families <dir> --sheet /tmp/familias.png
```
Una pieza nueva del catálogo: añadirla a `pieces.json` (pieza, metal, piedra, vista) y volver a correr; la prueba `every published demo SKU has a studio render` falla si falta alguna.
