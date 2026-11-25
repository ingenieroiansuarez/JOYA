import { Controller, Get, HttpCode, Inject, ServiceUnavailableException } from "@nestjs/common";
import { Public } from "./public.decorator";
import { Probes, PROBES } from "./probes";

/** Infrastructure probes, outside /v1 and outside the client contract. They expose no data. */
@Controller()
export class HealthController {
  constructor(@Inject(PROBES) private readonly probes: Probes) {}

  @Public()
  @Get("healthz")
  @HttpCode(200)
  live() {
    return { status: "ok" };
  }

  @Public()
  @Get("readyz")
  async ready() {
    const checks = await this.probes.check();
    if (Object.values(checks).some((v) => v !== "ok")) throw new ServiceUnavailableException();
    return { status: "ok", checks };
  }
}
