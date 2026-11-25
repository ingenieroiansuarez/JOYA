# Probar la app en un teléfono Android (local)

Build debug instalado por USB. El teléfono alcanza Keycloak, la API y Metro del portátil por `adb reverse`, así que el emisor sigue siendo `http://127.0.0.1:<KC_PORT>` y no hay que cambiar `KC_HOSTNAME` ni abrir puertos en la red. Probado el 2026-11-25 en un Galaxy Z Flip 7 (Android 17) desde Windows.

## Requisitos
- Node 22.23.5 y pnpm 10.28.0 (`corepack enable`). Con otro Node instalado, `fnm install 22.23.5 && fnm use 22.23.5`.
- Docker, JDK 21 y Android SDK. `ANDROID_HOME` apuntando al SDK y `platform-tools` en el `PATH`.
- Teléfono con Depuración USB activada y la huella RSA del portátil aceptada (`adb devices` → `device`). En Samsung, el Bloqueador automático impide instalar por USB.

## Pasos
```sh
pnpm install --frozen-lockfile
pnpm bootstrap                      # .env local con contraseñas aleatorias (git-ignored)
docker compose up -d --wait
# cargar .env en el entorno (PowerShell: Get-Content .env | % { if ($_ -match '^([^#=]+)=(.*)$') { Set-Item "env:$($matches[1])" $matches[2] } })
pnpm db:migrate
API_PORT=3900 pnpm api:start        # o el puerto libre que se quiera

adb reverse tcp:$KC_PORT tcp:$KC_PORT
adb reverse tcp:3900 tcp:3900
adb reverse tcp:8081 tcp:8081       # Metro

cd apps/mobile
EXPO_PUBLIC_AUREA_ENV=local \
EXPO_PUBLIC_OIDC_ISSUER=http://127.0.0.1:$KC_PORT/realms/aurea-local \
EXPO_PUBLIC_API_URL=http://127.0.0.1:3900 \
EXPO_NO_TELEMETRY=1 \
pnpm exec expo run:android --variant debug
```
Usuario `dev.cliente`; la contraseña es el valor de `KC_DEV_USER_PASSWORD` en `.env`. Resultado esperado: "Sesión iniciada" y "Roles: customer".

## Problemas conocidos
- Si el cable o la depuración USB se cortan, se pierden los `adb reverse`: el login se queda cargando y termina en "No se pudo iniciar sesión". Reconectar y repetir los `adb reverse`.
- Windows: el ninja de CMake 3.22.1 del SDK falla con rutas de más de 260 caracteres (pnpm las genera). Usar ninja ≥ 1.12 y apuntar `cmake.dir` en `apps/mobile/android/local.properties` (git-ignored) a una copia de CMake con ese ninja.
- Si Docker Desktop corta la descarga de capas grandes (EOF), reiniciarlo; si persiste, descargar las capas fuera de Docker, verificar el sha256 contra el digest de `compose.yaml` y cargarlas con `docker load`.
