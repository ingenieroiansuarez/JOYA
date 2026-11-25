# Página para inversionistas

Página estática de venta para inversionistas (HTML único). Fuente publicada en Vercel desde esta carpeta.
El costeo es una estimación con supuestos y fuentes citadas en la página; los 420 M COP son el valor de referencia indicado por ian (2026-11-25).

## v3 (2026-11-25): nivel Awwwards
Concepto: un solo anillo 3D (Three.js r128) fijo detrás de la página cuenta la historia con el scroll: se entra atravesándolo, los controles cambian su geometría, AURA lo vuelve platino, el taller lo ve como malla y vuelve en oro al cierre.
Librerías por CDN con versión fija: three r128, GSAP 3.12.5 + ScrollTrigger (cdnjs), Lenis 1.1.13 (unpkg). Sin build.
Respaldos: `prefers-reduced-motion` (sin scroll suave ni escenas fijadas, anillo estático por capítulo) y sin WebGL o sin librerías (contenido completo visible).
Referencias de técnica (no de contenido): Unique Jewelry (Awwwards), RINQ, Codrops "Curve Gallery".

## Costos de operación (2026-11-25)
Sección "Mantenerla en línea": costo mensual por servicio en escenarios piloto y crecimiento, con IA de AURA en Claude Haiku 5.5 o Sonnet 5.5 (supuesto: 6.000 tokens de entrada y 1.000 de salida por conversación; 2.000 y 30.000 conversaciones al mes). Precios de lista del 25 de noviembre de 2026 con fuente por fila. También corrige el orden de refresco de ScrollTrigger (refreshPriority) que hacía aparecer el anillo antes de tiempo.
