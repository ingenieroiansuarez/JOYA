import { DynamicModule, Module, Type } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import type { Config } from "./config";
import { DenyByDefaultGuard } from "./deny-by-default.guard";
import { ErrorsFilter } from "./errors.filter";
import { HealthController } from "./health.controller";
import { Probes, PROBES } from "./probes";

@Module({})
export class AppModule {
  /** `extra` lets feature modules (and tests) add controllers under the same guard and filter. */
  static register(config: Config, probes: Probes, extra: Type[] = []): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, ...extra],
      providers: [
        { provide: "CONFIG", useValue: config },
        { provide: PROBES, useValue: probes },
        { provide: APP_GUARD, useClass: DenyByDefaultGuard },
        { provide: APP_FILTER, useClass: ErrorsFilter },
      ],
    };
  }
}
