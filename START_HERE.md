# Inicio para Claude Code
Extraer ZIP en un directorio nuevo. Abrirlo como workspace; mantener los documentos como fuente de requisitos y crear código bajo `apps/`, `services/`, `packages/`, `infra/` y `tests/` sin sustituir los contratos existentes silenciosamente.

- Leer CLAUDE.md, matriz completa y roadmap. Crear `STATUS.md` con hitos y riesgos, y registrar los ADRs.
- Ejecutar `python -m unittest discover -s 23_SIMULATORS -p "test_*.py" -v` desde la raíz. Abrir el prototipo HTML. No confundir estos resultados con QA del producto.
- Empezar por 000: medir render Android, operaciones CAD, AR, mallas y exportación, incluyendo evidencia de licencias. Si no hay hardware/credenciales, registrar bloqueo, construir fixtures y probar lo que sea posible.
- Trabajar con ramas cortas y PR. No crear todos los frontends a la vez: primero customer y command-center; otras superficies comparten rutas hasta que se justifique extracción.
- Mantener `STATUS.md` con comandos, resultados, evidencia, requisitos cubiertos y siguientes acciones. No marcar hitos por cantidad de pantallas.

Entorno sugerido para Windows: WSL2/Docker Desktop para backend, Git, Android Studio/SDK en Windows, dispositivo físico por ADB, Node LTS y pnpm compatibles con Expo, Python compatible con CadQuery/OCP. Fijar versiones exactas y digest de imágenes después de la PoC; no usar latest en producción. Configurar IP LAN o adb reverse para conectar Android al backend; nunca asumir que localhost del teléfono es el PC.
