import { SetMetadata } from "@nestjs/common";

export const REQUIRED_PERMISSION = "aurea:permission";
/**
 * The permission a route requires, the same string as its OpenAPI `x-permission`.
 * An authenticated route without one is refused (403): forgetting it never opens a route.
 */
export const RequirePermission = (permission: string) => SetMetadata(REQUIRED_PERMISSION, permission);
