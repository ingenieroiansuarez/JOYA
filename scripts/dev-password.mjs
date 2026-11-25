// Types the local test user's password (KC_DEV_USER_PASSWORD from .env) into the field that has
// focus on the phone connected by USB, so nobody has to copy a 48-character value by hand. Local
// only: refuses outside AUREA_ENV=local, never prints the value, and only sends hex characters
// (what pnpm bootstrap generates), which `adb shell input text` passes through unchanged.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Reads one key from .env text. Returns undefined when absent. */
export function envValue(text, key) {
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i > 0 && line.slice(0, i).trim() === key) return line.slice(i + 1).trim();
  }
  return undefined;
}

/** Builds the adb calls; throws with a message that never contains the secret. */
export function plan(envText, { enter = false, serial } = {}) {
  const auraEnv = envValue(envText, "AUREA_ENV");
  if (auraEnv !== "local") throw new Error(`AUREA_ENV=${auraEnv ?? "(sin valor)"}: solo para desarrollo local`);
  const pw = envValue(envText, "KC_DEV_USER_PASSWORD");
  if (!pw) throw new Error("KC_DEV_USER_PASSWORD no está en .env (ejecuta pnpm bootstrap)");
  if (!/^[0-9a-f]{16,128}$/.test(pw)) throw new Error("KC_DEV_USER_PASSWORD no es el valor hexadecimal de pnpm bootstrap; escríbela a mano");
  const adb = (...args) => (serial ? ["-s", serial, ...args] : args);
  const calls = [adb("shell", "input", "text", pw)];
  if (enter) calls.push(adb("shell", "input", "keyevent", "66"));
  return calls;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const serial = args.includes("-s") ? args[args.indexOf("-s") + 1] : process.env.ANDROID_SERIAL;
  const file = `${ROOT}.env`;
  try {
    if (!existsSync(file)) throw new Error(".env no existe (ejecuta pnpm bootstrap)");
    const calls = plan(readFileSync(file, "utf8"), { enter: args.includes("--enter"), serial });
    for (const call of calls) {
      // stdio ignored on purpose: the password is an argument and must not be echoed anywhere.
      const r = spawnSync("adb", call, { stdio: ["ignore", "ignore", "pipe"] });
      if (r.error) throw new Error(`no se pudo ejecutar adb: ${r.error.code ?? r.error.message}`);
      if (r.status !== 0) throw new Error("adb falló: ¿teléfono conectado y autorizado? (adb devices)");
    }
    console.log("Contraseña de dev.cliente escrita en el teléfono (no se muestra).");
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
