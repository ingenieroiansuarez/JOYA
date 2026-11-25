import { Controller, Get, Headers, Inject, NotFoundException, Param, Query, Res } from "@nestjs/common";
import type { Pool } from "pg";
import { DATABASE, query } from "../database";
import { Public } from "../public.decorator";
import {
  decodeCursor, encodeCursor, parseCategory, parseLimit, parseUuid, pickLocale, PRODUCT_COLUMNS, ProductRow, toProduct, toSummary,
} from "./catalog";

interface LangResponse { setHeader(name: string, value: string): void }

/** OpenAPI listProducts / getProduct: published products only, readable by anyone (catalog.read, scope public). */
@Controller("catalog/products")
export class CatalogController {
  constructor(@Inject(DATABASE) private readonly pool: Pool) {}

  @Get()
  @Public()
  async list(
    @Query("cursor") cursor: string | undefined,
    @Query("limit") limitParam: string | undefined,
    @Query("category") categoryParam: string | undefined,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @Res({ passthrough: true }) res: LangResponse,
  ) {
    const limit = parseLimit(limitParam);
    const category = parseCategory(categoryParam);
    const after = decodeCursor(cursor, "number");
    const locale = pickLocale(acceptLanguage);
    const rows = await query<ProductRow>(
      this.pool,
      `SELECT ${PRODUCT_COLUMNS} FROM aurea.product p
        WHERE p.published_at IS NOT NULL AND ($2::text IS NULL OR p.category = $2)
          AND ($3::int IS NULL OR (p.position, p.id) > ($3::int, $4::uuid))
        ORDER BY p.position, p.id LIMIT $5`,
      [locale, category, after?.[0] ?? null, after?.[1] ?? null, limit + 1],
    );
    res.setHeader("content-language", locale);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { items: page.map(toSummary), nextCursor: rows.length > limit ? encodeCursor([last.position, last.id]) : null };
  }

  @Get(":id")
  @Public()
  async get(
    @Param("id") idParam: string,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @Res({ passthrough: true }) res: LangResponse,
  ) {
    const id = parseUuid(idParam);
    const locale = pickLocale(acceptLanguage);
    const [row] = await query<ProductRow>(
      this.pool,
      `SELECT ${PRODUCT_COLUMNS} FROM aurea.product p WHERE p.id = $2 AND p.published_at IS NOT NULL`,
      [locale, id],
    );
    // Unpublished and missing look the same: drafts are not discoverable by id.
    if (!row) throw new NotFoundException();
    res.setHeader("content-language", locale);
    return toProduct(row);
  }
}
