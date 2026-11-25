import { DynamicModule, Module, Type } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import type { Config } from "./config";
import { ErrorsFilter } from "./errors.filter";
import { HealthController } from "./health.controller";
import { AuthGuard, TOKEN_VERIFIER } from "./identity/auth.guard";
import { MeController } from "./identity/me.controller";
import type { TokenVerifier } from "./identity/verifier";
import { Probes, PROBES } from "./probes";

@Module({})
export class AppModule {
  /** `extra` lets feature modules (and tests) add controllers under the same guard and filter. */
  static register(config: Config, probes: Probes, verifier: TokenVerifier, extra: Type[] = []): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, MeController, ...extra],
      providers: [
        { provide: "CONFIG", useValue: config },
        { provide: PROBES, useValue: probes },
        { provide: TOKEN_VERIFIER, useValue: verifier },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ErrorsFilter },
      ],
    };
  }
}
