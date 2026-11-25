import { HttpException } from "@nestjs/common";

export interface ErrorDetail { code: string; pointer?: string; message: string }

/** An error with a specific errors.json code and details; ErrorsFilter renders it as OpenAPI `Error`. */
export class ApiError extends HttpException {
  constructor(status: number, readonly code: string, readonly details: ErrorDetail[] = [], readonly publicMessage?: string) {
    super(code, status);
  }
}

/** Issues from @aurea/design → ErrorDetail (path → JSON pointer). */
export function toDetails(issues: { code: string; path: string; message: string }[]): ErrorDetail[] {
  return issues.slice(0, 100).map((i) => ({ code: i.code, pointer: i.path || "", message: i.message.slice(0, 500) }));
}
