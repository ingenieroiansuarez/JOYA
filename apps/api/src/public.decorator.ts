import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC = "aurea:public";
/** Marks a route as reachable without a token. Everything else is denied by default. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
