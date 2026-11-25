# Stack y fijación de versiones
Android: React Native, Expo Development Builds, Expo Router, Kotlin/C++ NDK, Filament candidato, WebView Three.js/WASM alternativa, CameraX/MediaPipe y ARCore o SDK comercial; SQLite, SecureStore/Keystore. Web: Next.js/TS, React Three Fiber, Three.js, Zustand, TanStack Query, React Hook Form, Zod, i18next, Storybook. Backend: Node LTS/NestJS, Drizzle SQL migrations, PostgreSQL/pgvector, Redis/BullMQ, S3-compatible, WebSocket, FastAPI/Python, CadQuery/OCCT, Manifold, trimesh, numpy, Blender/Cycles, rhino3dm. OIDC Keycloak. CI GitHub Actions, Gradle/EAS, Terraform, OTel, Vitest/Jest/pytest/Playwright/Maestro/Testcontainers/k6/axe/Trivy/Semgrep.

Versiones: Claude debe resolver compatibilidad Expo SDK/RN/React/Gradle/JDK/NDK/Filament ABI; Node/pnpm/Turbo/Next; Python/CadQuery/OCP/OCCT/Manifold/Blender; PostgreSQL/pgvector y Redis/BullMQ. Registrar matriz de versiones exactas y lockfiles, imagen digest, licencia SPDX, origen y revisión. No se han instalado ni probado estas dependencias en este paquete. Comprobar especialmente condiciones de OCCT, Blender, modelos IA, HDRI, fuentes y distribución de binarios; consultar asesoría si hay duda.

Fuentes técnicas verificadas para orientar la PoC:
- https://docs.expo.dev/build-reference/apk/ — APK interna.
- https://docs.expo.dev/tutorial/eas/configure-development-build/ — módulos nativos y dev builds.
- https://cadquery.readthedocs.io/en/stable/importexport.html — formatos y unidades.
- https://github.com/google/filament — render PBR y Android.
- https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html — atomicidad de outbox.
- https://cheatsheetseries.owasp.org/cheatsheets/Business_Logic_Security_Cheat_Sheet.html — controles de negocio.
- https://codelabs.developers.google.com/codelabs/arcore-depth — profundidad disponible solo en dispositivos compatibles.
