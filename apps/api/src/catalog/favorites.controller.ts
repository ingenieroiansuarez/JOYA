import { Controller, Delete, Get, Headers, HttpCode, Inject, NotFoundException, Param, Put, Query, Req, Res } from "@nestjs/common";
import type { Pool } from "pg";
import { DATABASE, query } from "../database";
import { RequirePermission } from "../identity/permission.decorator";
import type { Principal } from "../identity/principal";
import { decodeCursor, encodeCursor, pickLocale, PRODUCT_COLUMNS, ProductRow, parseUuid, toSummary } from "./catalog";

interface AuthedRequest { principal: Principal }
interface LangResponse { setHeader(name: string, value: string): void }
const PAGE = 20;

/**
 * OpenAPI listFavorites / addFavorite / removeFavorite. Scope `own`: every query is keyed by the
 * caller's token subject, so one customer can never read or change another's favorites.
 */
@Controller("me/favorites")
export class FavoritesController {
  constructor(@Inject(DATABASE) private readonly pool: Pool) {}

  @Get()
  @RequirePermission("favorite.read")
  async list(
    @Req() req: AuthedRequest,
    @Query("cursor") cursor: string | undefined,
    @Headers("accept-language") acceptLanguage: string | undefined,
    @Res({ passthrough: true }) res: LangResponse,
  ) {
    const after = decodeCursor(cursor, "string");
    const locale = pickLocale(acceptLanguage);
    const rows = await query<ProductRow & { saved_at: string }>(
      this.pool,
      `SELECT ${PRODUCT_COLUMNS}, f.created_at::text AS saved_at
         FROM aurea.favorite f
         JOIN aurea.customer c ON c.id = f.customer_id AND c.subject = $2
         JOIN aurea.product p ON p.id = f.product_id AND p.published_at IS NOT NULL
        WHERE ($3::timestamptz IS NULL OR (f.created_at, f.product_id) < ($3::timestamptz, $4::uuid))
        ORDER BY f.created_at DESC, f.product_id DESC LIMIT $5`,
      [locale, req.principal.subject, after?.[0] ?? null, after?.[1] ?? null, PAGE + 1],
    );
    res.setHeader("content-language", locale);
    const page = rows.slice(0, PAGE);
    const last = page[page.length - 1];
    return { items: page.map(toSummary), nextCursor: rows.length > PAGE ? encodeCursor([last.saved_at, last.id]) : null };
  }

  @Put(":productId")
  @HttpCode(204)
  @RequirePermission("favorite.edit")
  async add(@Req() req: AuthedRequest, @Param("productId") productParam: string): Promise<void> {
    const productId = parseUuid(productParam);
    // One statement: create the customer row on first use, then save; repeating it changes nothing.
    // Two concurrent first saves by the same new customer can both miss the customer row in their
    // snapshot (customer_id NULL, 23502); the retry sees the committed row.
    for (let attempt = 0; ; attempt++) {
      try {
        if (!(await this.save(req.principal.subject, productId))) throw new NotFoundException();
        return;
      } catch (err) {
        if (attempt === 0 && (err as { code?: string }).code === "23502") continue;
        throw err;
      }
    }
  }

  private async save(subject: string, productId: string): Promise<boolean> {
    const [row] = await query<{ published: boolean }>(
      this.pool,
      `WITH prod AS (SELECT id FROM aurea.product WHERE id = $2 AND published_at IS NOT NULL),
            ins AS (INSERT INTO aurea.customer(id, subject) SELECT gen_random_uuid(), $1 WHERE EXISTS (SELECT 1 FROM prod)
                    ON CONFLICT (subject) DO NOTHING RETURNING id),
            cust AS (SELECT id FROM ins UNION ALL SELECT id FROM aurea.customer WHERE subject = $1),
            fav AS (INSERT INTO aurea.favorite(customer_id, product_id)
                    SELECT (SELECT id FROM cust LIMIT 1), prod.id FROM prod
                    ON CONFLICT DO NOTHING)
       SELECT EXISTS (SELECT 1 FROM prod) AS published`,
      [subject, productId],
    );
    return row.published;
  }

  @Delete(":productId")
  @HttpCode(204)
  @RequirePermission("favorite.edit")
  async remove(@Req() req: AuthedRequest, @Param("productId") productParam: string): Promise<void> {
    const productId = parseUuid(productParam);
    await query(
      this.pool,
      `DELETE FROM aurea.favorite f USING aurea.customer c
        WHERE c.id = f.customer_id AND c.subject = $1 AND f.product_id = $2`,
      [req.principal.subject, productId],
    );
  }
}
