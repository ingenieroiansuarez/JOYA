import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { IS_PUBLIC } from "./public.decorator";

/**
 * Hito 100 skeleton: identity (OIDC + PKCE) is not wired yet, so every non-public route
 * answers 401. The OIDC guard replaces this one; it must keep the same default.
 */
@Injectable()
export class DenyByDefaultGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;
    throw new UnauthorizedException();
  }
}
