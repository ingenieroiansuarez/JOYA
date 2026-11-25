// Portable launcher (Windows cmd has no `VAR=1 cmd`): loads the repo's .env when asked, turns off
// telemetry, then runs the Next CLI with the remaining arguments. Env flags can't go through
// `node --env-file` because Next copies execArgv into its workers' NODE_OPTIONS, which refuses them.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const withEnv = args[0] === "--repo-env";
if (withEnv) {
  args.shift();
  const file = fileURLToPath(new URL("../../../.env", import.meta.url));
  if (existsSync(file)) process.loadEnvFile(file);
}
process.env.NEXT_TELEMETRY_DISABLED = "1";
process.argv = [process.argv[0], "next", ...args];
// import() needs a file:// URL: a bare "C:\\..." path is read as a URL with scheme "c:" on Windows.
await import(pathToFileURL(createRequire(import.meta.url).resolve("next/dist/bin/next")).href);
