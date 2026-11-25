import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
// Minimal shapes of the Express request/response used here (avoids depending on @types/express).
interface Request { header(name: string): string | undefined }
interface Response { setHeader(name: string, value: string): void; status(code: number): { json(body: unknown): void } }

// Body follows OpenAPI `Error`; codes come from 06_API_CONTRACTS/errors.json.
const BY_STATUS: Record<number, string> = {
  400: "VALIDATION_FAILED",
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "VERSION_CONFLICT",
  422: "INVARIANT_VIOLATED",
  429: "RATE_LIMITED",
  500: "INTERNAL_ERROR",
  503: "SERVICE_UNAVAILABLE",
};
const MESSAGES: Record<string, string> = {
  VALIDATION_FAILED: "La solicitud no es válida.",
  UNAUTHENTICATED: "Se requiere autenticación.",
  FORBIDDEN: "No tiene permiso para esta acción.",
  NOT_FOUND: "No encontrado.",
  VERSION_CONFLICT: "El recurso cambió; vuelva a cargarlo.",
  INVARIANT_VIOLATED: "La operación incumple una regla del negocio.",
  RATE_LIMITED: "Demasiadas solicitudes.",
  SERVICE_UNAVAILABLE: "Servicio no disponible; intente de nuevo.",
  INTERNAL_ERROR: "Error interno.",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function correlationId(req: Request): string {
  const given = req.header("x-correlation-id");
  return given && UUID.test(given) ? given.toLowerCase() : randomUUID();
}

@Catch()
export class ErrorsFilter implements ExceptionFilter {
  private readonly log = new Logger("errors");

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    let status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const id = correlationId(req);
    if (!(exception instanceof HttpException)) {
      // Never leak internals to the client; log class and correlation id only (messages may carry PII).
      const kind = exception instanceof Error ? exception.constructor.name : typeof exception;
      this.log.error(`unhandled ${kind} status=${status} correlationId=${id}`);
    }
    if (!BY_STATUS[status]) status = HttpStatus.INTERNAL_SERVER_ERROR;
    const code = BY_STATUS[status];
    res.setHeader("x-correlation-id", id);
    res.status(status).json({ code, message: MESSAGES[code], correlationId: id, details: [] });
  }
}
