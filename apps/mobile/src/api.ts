// Typed client for the catalog and favorites (OpenAPI 1.8.0). Every failure becomes an ApiError with a
// kind the UI can explain; nothing is retried silently and no empty list is invented on error.
import type { AppConfig } from "./config";
import type { Locale } from "./i18n";

export type Category = "RING" | "PENDANT" | "EARRINGS" | "BRACELET" | "NECKLACE";
export const CATEGORIES: Category[] = ["RING", "PENDANT", "EARRINGS", "BRACELET", "NECKLACE"];
export type Metal = "GOLD_18K_YELLOW" | "GOLD_18K_WHITE" | "GOLD_18K_ROSE" | "SILVER_925" | "PLATINUM_950";
export interface Money { amount: string; currency: string }
export interface ProductSummary {
  id: string; sku: string; name: string; category: Category; metal: Metal; price: Money; available: boolean; customizable: boolean;
}
export interface ProductStone { type: "DIAMOND" | "EMERALD" | "RUBY" | "SAPPHIRE"; count: number; totalCarats: string; origin: "NATURAL" | "LAB_GROWN" | "SIMULANT" }
export interface Product extends ProductSummary {
  summary: string; description: string; collection: string | null; metalWeightGrams: string; stones: ProductStone[];
}
export interface ProductPage { items: ProductSummary[]; nextCursor: string | null }

export type ApiErrorKind = "offline" | "unavailable" | "notFound" | "unauthenticated" | "forbidden" | "invalid" | "unexpected";
export class ApiError extends Error {
  constructor(readonly kind: ApiErrorKind, readonly status?: number) {
    super(`api ${kind}${status ? ` ${status}` : ""}`);
  }
}

export function kindFor(status: number): ApiErrorKind {
  if (status === 401) return "unauthenticated";
  if (status === 403) return "forbidden";
  if (status === 404) return "notFound";
  if (status === 400) return "invalid";
  if (status === 429 || status === 503 || status === 502 || status === 504) return "unavailable";
  return "unexpected";
}

const TIMEOUT_MS = 10_000;
type Fetch = typeof fetch;

export class Api {
  constructor(private readonly config: AppConfig, private readonly locale: Locale, private readonly fetchImpl: Fetch = fetch) {}

  private async request<T>(method: string, path: string, token?: string): Promise<T | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const headers: Record<string, string> = { accept: "application/json", "accept-language": this.locale };
    if (token) headers.authorization = `Bearer ${token}`;
    let r: Response;
    try {
      r = await this.fetchImpl(`${this.config.apiUrl}/v1${path}`, { method, headers, signal: controller.signal });
    } catch {
      throw new ApiError("offline"); // no network, DNS, refused or timed out
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) throw new ApiError(kindFor(r.status), r.status);
    if (r.status === 204) return undefined;
    return (await r.json()) as T;
  }

  listProducts(opts: { cursor?: string | null; category?: Category | null } = {}): Promise<ProductPage> {
    const q = new URLSearchParams({ limit: "20" });
    if (opts.cursor) q.set("cursor", opts.cursor);
    if (opts.category) q.set("category", opts.category);
    return this.request<ProductPage>("GET", `/catalog/products?${q}`) as Promise<ProductPage>;
  }

  getProduct(id: string): Promise<Product> {
    return this.request<Product>("GET", `/catalog/products/${encodeURIComponent(id)}`) as Promise<Product>;
  }

  listFavorites(token: string, cursor?: string | null): Promise<ProductPage> {
    const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    return this.request<ProductPage>("GET", `/me/favorites${q}`, token) as Promise<ProductPage>;
  }

  async setFavorite(token: string, id: string, saved: boolean): Promise<void> {
    await this.request(saved ? "PUT" : "DELETE", `/me/favorites/${encodeURIComponent(id)}`, token);
  }
}
