import { randomBytes } from "node:crypto";

import db from "../../db.server";

export interface CachedRankedProduct {
  productId: string;
  handle: string;
  score: number;
}

export interface CachedSearchResult {
  receiptId: string;
  shop: string;
  query: string;
  searchLogId: string | null;
  rankedProducts: CachedRankedProduct[];
  total: number;
  createdAt: number;
  expiresAt: number;
}

export interface CachedSearchResultPage {
  result: CachedSearchResult;
  page: number;
  pageSize: number;
  totalProducts: number;
  totalPages: number;
  products: CachedRankedProduct[];
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const MIN_TTL_MS = 60 * 1000;

function normalizeShop(shop: string) {
  return shop.trim().toLowerCase();
}

function createReceiptId() {
  return `srch_${randomBytes(18).toString("base64url")}`;
}

function normalizeRankedProducts(products: CachedRankedProduct[]) {
  const seen = new Set<string>();
  const result: CachedRankedProduct[] = [];
  for (const product of products) {
    const productId = product.productId.trim();
    const handle = product.handle.trim();
    if (!productId || !handle || seen.has(productId)) continue;
    seen.add(productId);
    result.push({
      productId,
      handle,
      score: Number.isFinite(product.score) ? product.score : 0,
    });
  }
  return result;
}

function parseProducts(value: string): CachedRankedProduct[] | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return null;
    const products: CachedRankedProduct[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") return null;
      const row = entry as Record<string, unknown>;
      if (
        typeof row.productId !== "string" ||
        typeof row.handle !== "string" ||
        typeof row.score !== "number"
      ) return null;
      products.push({
        productId: row.productId,
        handle: row.handle,
        score: row.score,
      });
    }
    return products;
  } catch {
    return null;
  }
}

export async function saveSearchResult(args: {
  shop: string;
  query: string;
  searchLogId?: string | null;
  rankedProducts: CachedRankedProduct[];
  ttlMs?: number;
  receiptId?: string;
}): Promise<CachedSearchResult> {
  const receiptId = args.receiptId ?? createReceiptId();
  const createdAt = new Date();
  const expiresAt = new Date(
    createdAt.getTime() + Math.max(MIN_TTL_MS, args.ttlMs ?? DEFAULT_TTL_MS),
  );
  const rankedProducts = normalizeRankedProducts(args.rankedProducts);
  const shop = normalizeShop(args.shop);
  await db.aiSearchResultReceipt.create({
    data: {
      receiptId,
      shop,
      query: args.query,
      searchLogId: args.searchLogId ?? null,
      rankedProductsJson: JSON.stringify(rankedProducts),
      total: rankedProducts.length,
      createdAt,
      expiresAt,
    },
  });
  return {
    receiptId,
    shop,
    query: args.query,
    searchLogId: args.searchLogId ?? null,
    rankedProducts,
    total: rankedProducts.length,
    createdAt: createdAt.getTime(),
    expiresAt: expiresAt.getTime(),
  };
}

export async function getSearchResult(
  shop: string,
  receiptId: string,
): Promise<CachedSearchResult | null> {
  if (!receiptId) return null;
  const row = await db.aiSearchResultReceipt.findFirst({
    where: {
      receiptId,
      shop: normalizeShop(shop),
      expiresAt: { gt: new Date() },
    },
  });
  if (!row) return null;
  const rankedProducts = parseProducts(row.rankedProductsJson);
  if (!rankedProducts || rankedProducts.length !== row.total) return null;
  return {
    receiptId: row.receiptId,
    shop: row.shop,
    query: row.query,
    searchLogId: row.searchLogId,
    rankedProducts,
    total: row.total,
    createdAt: row.createdAt.getTime(),
    expiresAt: row.expiresAt.getTime(),
  };
}

export async function getSearchResultPage(args: {
  shop: string;
  receiptId: string;
  page: number;
  pageSize: number;
}): Promise<CachedSearchResultPage | null> {
  const result = await getSearchResult(args.shop, args.receiptId);
  if (!result) return null;
  const pageSize = Math.max(1, Math.floor(args.pageSize));
  const totalPages = Math.max(1, Math.ceil(result.total / pageSize));
  const requestedPage = Number.isFinite(args.page) ? Math.floor(args.page) : 1;
  const page = Math.min(Math.max(1, requestedPage), totalPages);
  const start = (page - 1) * pageSize;
  return {
    result,
    page,
    pageSize,
    totalProducts: result.total,
    totalPages,
    products: result.rankedProducts.slice(start, start + pageSize),
  };
}

export async function deleteSearchResult(shop: string, receiptId: string) {
  await db.aiSearchResultReceipt.deleteMany({
    where: { shop: normalizeShop(shop), receiptId },
  });
}

export async function clearExpiredSearchResults(now = new Date()) {
  return db.aiSearchResultReceipt.deleteMany({ where: { expiresAt: { lte: now } } });
}
