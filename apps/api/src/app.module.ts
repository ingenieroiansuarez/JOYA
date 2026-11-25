import { DynamicModule, Inject, Module, OnApplicationShutdown, Type } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import type { Pool } from "pg";
import { AI_RUNTIME, AiController, type AiRuntime } from "./ai/ai.controller";
import { CatalogController } from "./catalog/catalog.controller";
import { FavoritesController } from "./catalog/favorites.controller";
import type { Config } from "./config";
import { createPool, DATABASE } from "./database";
import type { DesignConfig } from "./design/config";
import { FamiliesController } from "./design/families.controller";
import { FilesController } from "./design/files.controller";
import { DESIGN_CONFIG, JobsController } from "./design/jobs.controller";
import { ProjectsController } from "./design/projects.controller";
import { SyncController } from "./design/sync.controller";
import { ErrorsFilter } from "./errors.filter";
import { HealthController } from "./health.controller";
import { AuthGuard, TOKEN_VERIFIER } from "./identity/auth.guard";
import { MeController } from "./identity/me.controller";
import type { TokenVerifier } from "./identity/verifier";
import { Probes, PROBES } from "./probes";

@Module({})
export class AppModule implements OnApplicationShutdown {
  constructor(@Inject(DATABASE) private readonly pool: Pool) {}

  /**
   * `extra` lets feature modules (and tests) add controllers under the same guard and filter.
   * `pool` defaults to a lazy pool on DATABASE_URL; it is closed with the application.
   */
  static register(config: Config, probes: Probes, verifier: TokenVerifier, extra: Type[] = [], pool?: Pool): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        HealthController, MeController, CatalogController, FavoritesController,
        FamiliesController, ProjectsController, JobsController, FilesController, SyncController, AiController, ...extra,
      ],
      providers: [
        { provide: "CONFIG", useValue: config },
        { provide: DESIGN_CONFIG, useValue: (config as Config & { design?: DesignConfig }).design ?? null },
        { provide: AI_RUNTIME, useValue: (config as Config & { ai?: AiRuntime }).ai ?? null },
        { provide: DATABASE, useValue: pool ?? createPool(config) },
        { provide: PROBES, useValue: probes },
        { provide: TOKEN_VERIFIER, useValue: verifier },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ErrorsFilter },
      ],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end().catch(() => undefined);
  }
}
