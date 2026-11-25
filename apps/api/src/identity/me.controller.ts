import { Controller, Get, Req } from "@nestjs/common";
import { RequirePermission } from "./permission.decorator";
import type { Principal } from "./principal";

/** OpenAPI getMe: who the caller is, as the API sees it. */
@Controller()
export class MeController {
  @Get("me")
  @RequirePermission("identity.self")
  me(@Req() req: { principal: Principal }): Principal {
    const { subject, roles, permissions } = req.principal;
    return { subject, roles, permissions };
  }
}
