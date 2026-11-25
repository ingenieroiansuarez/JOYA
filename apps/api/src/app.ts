import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import type { Type } from "@nestjs/common";
import type { Config } from "./config";
import { Probes } from "./probes";
import type { TokenVerifier } from "./identity/verifier";

export async function createApp(
  config: Config,
  probes: Probes,
  verifier: TokenVerifier,
  extra: Type[] = [],
): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config, probes, verifier, extra), {
    logger: config.env === "ci" ? ["error"] : ["error", "warn", "log"],
  });
  app.setGlobalPrefix("v1", { exclude: ["healthz", "readyz"] });
  app.disable("x-powered-by");
  app.useBodyParser("json", { limit: "1mb" });
  app.enableShutdownHooks();
  return app;
}
