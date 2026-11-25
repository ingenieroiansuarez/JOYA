import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { IS_PUBLIC } from "../public.decorator";
import { REQUIRED_PERMISSION } from "./permission.decorator";
import { Principal, principalFrom } from "./principal";
import { TokenVerifier, VerifierUnavailable } from "./verifier";

export const TOKEN_VERIFIER = Symbol("TOKEN_VERIFIER");
const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*)$/;

interface AuthRequest {
  headers: Record<string, string | string[] | undefined>;
  principal?: Principal;
}

/**
 * Deny by default. A non-public route needs a valid access token from the configured issuer for
 * this API's audience (401 otherwise) and a role granting the route's declared permission (403).
 * A route that declares no permission is refused for everyone (403).
 * Resource and location scopes (roles.reference.json `scopes`) are enforced by each module.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly log = new Logger("auth");

  constructor(
    private readonly reflector: Reflector,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    const req = ctx.switchToHttp().getRequest<AuthRequest>();
    const header = req.headers.authorization;
    const match = typeof header === "string" ? BEARER.exec(header) : null;
    if (!match) throw new UnauthorizedException();
    let claims: Record<string, unknown>;
    try {
      claims = await this.verifier.verify(match[1]);
    } catch (err) {
      if (err instanceof VerifierUnavailable) {
        this.log.warn(`identity provider unavailable (${err.message})`);
        throw new ServiceUnavailableException();
      }
      throw new UnauthorizedException(); // no reason given to the caller
    }
    const principal = principalFrom(claims);
    const required = this.reflector.getAllAndOverride<string | undefined>(REQUIRED_PERMISSION, targets);
    if (!required || !principal.permissions.includes(required)) throw new ForbiddenException();
    req.principal = principal;
    return true;
  }
}
