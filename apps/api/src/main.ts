import { createApp } from "./app";
import { ConfigError, loadConfig } from "./config";
import { createProbes } from "./probes";
import { createVerifier } from "./identity/verifier";

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`refusing to start: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  const probes = createProbes(config);
  const app = await createApp(config, probes, await createVerifier(config));
  process.once("SIGTERM", () => void probes.close());
  await app.listen(config.port, "127.0.0.1");
  console.log(`api listening on 127.0.0.1:${config.port} (${config.env})`);
}

void main();
