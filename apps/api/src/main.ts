import { createApp } from "./app";
import { ConfigError, loadConfig } from "./config";
import { createProbes } from "./probes";
import { createVerifier } from "./identity/verifier";
import { createPool } from "./database";
import { loadDesignConfig } from "./design/config";
import { loadAiConfig } from "./ai/config";
import { loadCommerceConfig } from "./commerce/config";
import { SimulatedAdapter } from "./ai/simulator";
import { JobRunner } from "./design/jobs";
import { ArtifactStore } from "./design/store";
import { GeometryWorker } from "./design/worker-client";

async function main() {
  let config;
  try {
    config = loadConfig();
    config.design = loadDesignConfig(process.env, config.env);
    config.ai = { config: loadAiConfig(process.env, config.env), adapter: new SimulatedAdapter() };
    config.commerce = loadCommerceConfig(process.env, config.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`refusing to start: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  const probes = createProbes(config);
  const pool = createPool(config);
  const app = await createApp(config, probes, await createVerifier(config), [], pool);
  const d = config.design!;
  const runner = new JobRunner(pool, new GeometryWorker(d.workerUrl, d.workerSecret, d.workerTimeoutMs), new ArtifactStore(d.artifactDir));
  if (process.env.JOB_RUNNER !== "off") runner.start();
  process.once("SIGTERM", () => runner.stop());
  process.once("SIGTERM", () => void probes.close());
  await app.listen(config.port, "127.0.0.1");
  console.log(`api listening on 127.0.0.1:${config.port} (${config.env})`);
}

void main();
