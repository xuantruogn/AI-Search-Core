import { createHash, randomBytes } from "node:crypto";

import db from "../../db.server";
import {
  QUERY_PARSER_VERSION,
  QUERY_ROUTER_VERSION,
} from "./query-plan.server";
import { getSearchCatalogRevisionCached } from "./search-catalog-revision.server";
import {
  BM25_MODEL,
  BM25_OPTIONS,
  QDRANT_COLLECTION,
  VECTOR_SIZE,
} from "./qdrant.server";
import {
  PRODUCT_SEMANTIC_PROFILE_SCHEMA_VERSION,
  PRODUCT_VECTOR_SEMANTIC_PAYLOAD_VERSION,
} from "./product-semantic-profile.server";
import {
  QUERY_EMBEDDING_PIPELINE_VERSION,
  QUERY_SEMANTIC_PROFILE_VERSION,
} from "./query-semantic-profile.server";
import { SEMANTIC_CONTRACT_VERSION } from "./semantic-contract.server";
import { PRODUCT_EMBEDDING_PIPELINE_VERSION } from "../products/product-indexer.server";

export interface CachedRankedProduct {
  productId: string;
  handle: string;
  score: number;
  vectorSimilarity?: number;
  primaryVectorSimilarity?: number;
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

const DEFAULT_RECEIPT_TTL_MS = 2 * 60 * 60 * 1000;
const MIN_TTL_MS = 60 * 1000;
const DEFAULT_QUERY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
const FULL_SEARCH_CACHE_PIPELINE_VERSION =
  "full-search-cache-v75-source-role-joint-demand-2026-10-07";

export type CachedSearchSortIntent =
  | "RELEVANCE"
  | "PRICE_ASC"
  | "PRICE_DESC"
  | "PREMIUM"
  | "BUDGET";

export interface SearchQueryCacheMetadata {
  query: string;
  sortIntent: CachedSearchSortIntent;
  priceConstraint: unknown | null;
  cacheKeyHash: string;
  tenantId: string;
  shopDomain: string;
  shopifyShopId: string | null;
  searchLanguage: string | null;
  productPolicyVersion: number;
  catalogRevision: string;
  catalogUpdatedAt: string | null;
  settingsUpdatedAt: string | null;
  requestVariant: string;
  pipelineVersion: string;
  proofBasedEmpty?: boolean;
  analyzedQuery?: string | null;
  llmExpandedQuery?: string | null;
  analysisSummary?: Record<string, unknown> | null;
  selectedContextSummary?: unknown[];
  diagnosticSummary?: Record<string, unknown> | null;
}

export interface SearchQueryCacheIdentity {
  receiptId: string;
  metadata: SearchQueryCacheMetadata;
}

export interface CachedSearchQueryResult {
  result: CachedSearchResult;
  metadata: SearchQueryCacheMetadata;
}

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
      vectorSimilarity:
        typeof product.vectorSimilarity === "number" &&
        Number.isFinite(product.vectorSimilarity)
          ? product.vectorSimilarity
          : undefined,
      primaryVectorSimilarity:
        typeof product.primaryVectorSimilarity === "number" &&
        Number.isFinite(product.primaryVectorSimilarity)
          ? product.primaryVectorSimilarity
          : undefined,
    });
  }
  return result;
}

function asIso(value: Date | null | undefined) {
  if (!value) return null;
  return Number.isNaN(value.getTime()) ? null : value.toISOString();
}

function normalizeSearchQuery(query: string) {
  return query.replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

function readQueryCacheTtlMs() {
  const parsed = Number.parseInt(
    process.env.AI_SEARCH_FULL_RESULT_CACHE_TTL_MS || "",
    10,
  );
  if (!Number.isSafeInteger(parsed) || parsed < MIN_TTL_MS) {
    return DEFAULT_QUERY_CACHE_TTL_MS;
  }
  return Math.min(parsed, 7 * 24 * 60 * 60 * 1000);
}

function readReceiptTtlMs() {
  const parsed = Number.parseInt(
    process.env.AI_SEARCH_RECEIPT_TTL_MS || "",
    10,
  );
  if (!Number.isSafeInteger(parsed) || parsed < MIN_TTL_MS) {
    return DEFAULT_RECEIPT_TTL_MS;
  }
  return Math.min(parsed, MAX_RECEIPT_TTL_MS);
}

export function currentSearchPipelineSignature() {
  return [
    FULL_SEARCH_CACHE_PIPELINE_VERSION,
    process.env.GEMINI_QUERY_REWRITE_MODEL?.trim() || "gemini-3.5-flash-lite",
    process.env.OPENAI_EMBEDDING_MODEL?.trim() || "text-embedding-3-small",
    `qdrant:${QDRANT_COLLECTION}`,
    `dense:${VECTOR_SIZE}`,
    `bm25:${BM25_MODEL}:${JSON.stringify(BM25_OPTIONS)}`,
    `product:${PRODUCT_EMBEDDING_PIPELINE_VERSION}`,
    `product-profile:${PRODUCT_SEMANTIC_PROFILE_SCHEMA_VERSION}`,
    `product-payload:${PRODUCT_VECTOR_SEMANTIC_PAYLOAD_VERSION}`,
    `query-profile:${QUERY_SEMANTIC_PROFILE_VERSION}`,
    `query-embedding:${QUERY_EMBEDDING_PIPELINE_VERSION}`,
    `semantic-contract:${SEMANTIC_CONTRACT_VERSION}`,
    process.env.AI_SEARCH_QUERY_ROUTER_ENABLED?.trim() || "default",
    QUERY_PARSER_VERSION,
    QUERY_ROUTER_VERSION,
    process.env.AI_SEARCH_CANDIDATE_LIMIT?.trim() || "500",
    process.env.AI_SEARCH_QDRANT_HEADROOM_RATIO?.trim() || "1",
    process.env.AI_SEARCH_VECTOR_SCORE_THRESHOLD?.trim() || "0.35",
    process.env.AI_SEARCH_VECTOR_RELATIVE_SCORE_RATIO?.trim() || "default",
    process.env.AI_SEARCH_DISCOVERY_VECTOR_RELATIVE_SCORE_RATIO?.trim() || "0.88",
    process.env.AI_SEARCH_DISCOVERY_MIN_RECALL_RESULTS?.trim() || "8",
    process.env.AI_SEARCH_NO_EVIDENCE_MIN_TOP_SCORE?.trim() || "0.50",
  ].join("|");
}

export async function buildSearchQueryCacheIdentity(args: {
  shop: string;
  query: string;
  requestVariant?: string | null;
  searchLanguage?: string | null;
}): Promise<SearchQueryCacheIdentity> {
  const shopDomain = normalizeShop(args.shop);
  const settings = await getSearchCatalogRevisionCached(shopDomain);

  const shopifyShopId = settings?.shopifyShopId ?? null;
  const tenantId = shopifyShopId
    ? "shopify:" + shopifyShopId
    : "domain:" + shopDomain;
  const searchLanguage =
    args.searchLanguage?.trim() || settings?.searchLanguage || null;
  const productPolicyVersion = settings?.productPolicyVersion ?? 0;
  const catalogRevision = settings?.catalogRevision ?? "0";
  const catalogUpdatedAt = asIso(settings?.catalogUpdatedAt);
  const settingsUpdatedAt = asIso(settings?.settingsUpdatedAt);
  const requestVariant = args.requestVariant?.trim() || "";
  const pipelineVersion = currentSearchPipelineSignature();
  const normalizedQuery = normalizeSearchQuery(args.query);

  const keyPayload = JSON.stringify({
    tenantId,
    shopDomain,
    normalizedQuery,
    searchLanguage,
    productPolicyVersion,
    catalogRevision,
    catalogUpdatedAt,
    settingsUpdatedAt,
    requestVariant,
    pipelineVersion,
  });
  const cacheKeyHash = createHash("sha256")
    .update(keyPayload)
    .digest("base64url");

  return {
    receiptId: "qcache_" + cacheKeyHash,
    metadata: {
      query: args.query,
      sortIntent: "RELEVANCE",
      priceConstraint: null,
      cacheKeyHash,
      tenantId,
      shopDomain,
      shopifyShopId,
      searchLanguage,
      productPolicyVersion,
      catalogRevision,
      catalogUpdatedAt,
      settingsUpdatedAt,
      requestVariant,
      pipelineVersion,
    },
  };
}

function parseSearchQueryCacheMetadata(
  value: string,
): SearchQueryCacheMetadata | null {
  try {
    const parsed = JSON.parse(value) as Partial<SearchQueryCacheMetadata>;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.query !== "string" ||
      typeof parsed.cacheKeyHash !== "string" ||
      typeof parsed.tenantId !== "string" ||
      typeof parsed.shopDomain !== "string" ||
      typeof parsed.requestVariant !== "string" ||
      typeof parsed.pipelineVersion !== "string"
    ) {
      return null;
    }

    const sortIntent = parsed.sortIntent;
    if (
      sortIntent !== "RELEVANCE" &&
      sortIntent !== "PRICE_ASC" &&
      sortIntent !== "PRICE_DESC" &&
      sortIntent !== "PREMIUM" &&
      sortIntent !== "BUDGET"
    ) {
      return null;
    }

    return parsed as SearchQueryCacheMetadata;
  } catch {
    return null;
  }
}

export async function getSearchQueryCache(
  shop: string,
  identity: SearchQueryCacheIdentity,
): Promise<CachedSearchQueryResult | null> {
  const result = await getSearchResult(shop, identity.receiptId);
  if (!result) return null;

  const metadata = parseSearchQueryCacheMetadata(result.query);
  if (!metadata || metadata.cacheKeyHash !== identity.metadata.cacheKeyHash) {
    return null;
  }

  // Empty vector/provider results are never reusable. The only reusable empty
  // result is one backed by a closed-world catalog proof.
  if (result.total === 0 && metadata.proofBasedEmpty !== true) return null;

  return { result, metadata };
}

export async function saveSearchQueryCache(args: {
  shop: string;
  identity: SearchQueryCacheIdentity;
  originalQuery: string;
  sortIntent: CachedSearchSortIntent;
  priceConstraint?: unknown | null;
  rankedProducts: CachedRankedProduct[];
  proofBasedEmpty?: boolean;
  analyzedQuery?: string | null;
  llmExpandedQuery?: string | null;
  analysisSummary?: Record<string, unknown> | null;
  selectedContextSummary?: unknown[];
  diagnosticSummary?: Record<string, unknown> | null;
}): Promise<CachedSearchQueryResult> {
  const shop = normalizeShop(args.shop);
  const rankedProducts = normalizeRankedProducts(args.rankedProducts);
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + readQueryCacheTtlMs());
  const metadata: SearchQueryCacheMetadata = {
    ...args.identity.metadata,
    query: args.originalQuery,
    sortIntent: args.sortIntent,
    priceConstraint: args.priceConstraint ?? null,
    proofBasedEmpty: args.proofBasedEmpty === true ? true : undefined,
    analyzedQuery: args.analyzedQuery?.trim() || null,
    llmExpandedQuery: args.llmExpandedQuery?.trim() || null,
    analysisSummary: args.analysisSummary ?? null,
    selectedContextSummary: args.selectedContextSummary ?? [],
    diagnosticSummary: args.diagnosticSummary ?? null,
  };

  await db.aiSearchResultReceipt.upsert({
    where: { receiptId: args.identity.receiptId },
    create: {
      receiptId: args.identity.receiptId,
      shop,
      query: JSON.stringify(metadata),
      searchLogId: null,
      rankedProductsJson: JSON.stringify(rankedProducts),
      total: rankedProducts.length,
      createdAt,
      expiresAt,
    },
    update: {
      shop,
      query: JSON.stringify(metadata),
      searchLogId: null,
      rankedProductsJson: JSON.stringify(rankedProducts),
      total: rankedProducts.length,
      createdAt,
      expiresAt,
    },
  });

  return {
    result: {
      receiptId: args.identity.receiptId,
      shop,
      query: JSON.stringify(metadata),
      searchLogId: null,
      rankedProducts,
      total: rankedProducts.length,
      createdAt: createdAt.getTime(),
      expiresAt: expiresAt.getTime(),
    },
    metadata,
  };
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
    createdAt.getTime() +
      Math.min(
        MAX_RECEIPT_TTL_MS,
        Math.max(MIN_TTL_MS, args.ttlMs ?? readReceiptTtlMs()),
      ),
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

export async function clearExpiredSearchResults(
  now = new Date(),
  options?: { batchSize?: number; maxBatches?: number },
) {
  const batchSize = Math.max(
    100,
    Math.min(Math.trunc(options?.batchSize ?? 5_000), 50_000),
  );
  const maxBatches = Math.max(
    1,
    Math.min(Math.trunc(options?.maxBatches ?? 20), 100),
  );

  let count = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const deleted = await db.$executeRaw`
      DELETE FROM \`AiSearchResultReceipt\`
      WHERE \`expiresAt\` <= ${now}
      LIMIT ${batchSize}
    `;
    count += deleted;
    if (deleted < batchSize) break;
  }
  return { count };
}
