import type { Prisma } from "@prisma/client";

import db from "../../db.server";
import type { ProductSemanticAnalysis } from "../products/product-embedding-input.server";

export type StoredSemanticTerm = {
  kind: string;
  value: string;
  normalizedValue: string;
};

export type StoredProductSemanticProfile = {
  schemaVersion: 1;
  analysis: ProductSemanticAnalysis | null;
  terms: StoredSemanticTerm[];
};

export type FlatSemanticRow = StoredSemanticTerm & {
  productId: string;
  updatedAt: Date;
};

const PROFILE_SCHEMA_VERSION = 1;
const CACHE_TTL_MS = (() => {
  const raw = Number.parseInt(
    process.env.AI_SEARCH_SEMANTIC_PROFILE_CACHE_TTL_MS || "",
    10,
  );
  return Number.isSafeInteger(raw) && raw >= 30_000
    ? Math.min(raw, 60 * 60_000)
    : 5 * 60_000;
})();
const cache = new Map<
  string,
  { expiresAt: number; rows: FlatSemanticRow[] }
>();
const pendingLoads = new Map<string, Promise<FlatSemanticRow[]>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseTerm(value: unknown): StoredSemanticTerm | null {
  if (!isRecord(value)) return null;
  const kind = typeof value.kind === "string" ? value.kind.trim() : "";
  const termValue = typeof value.value === "string" ? value.value.trim() : "";
  const normalizedValue =
    typeof value.normalizedValue === "string"
      ? value.normalizedValue.trim()
      : "";
  if (!kind || !termValue || !normalizedValue) return null;
  return { kind, value: termValue, normalizedValue };
}

export function parseStoredSemanticProfile(
  value: Prisma.JsonValue | null | undefined,
): StoredProductSemanticProfile {
  if (!isRecord(value)) {
    return { schemaVersion: 1, analysis: null, terms: [] };
  }

  const terms = Array.isArray(value.terms)
    ? value.terms.map(parseTerm).filter((term): term is StoredSemanticTerm => Boolean(term))
    : [];

  return {
    schemaVersion: 1,
    analysis: isRecord(value.analysis)
      ? (value.analysis as unknown as ProductSemanticAnalysis)
      : null,
    terms,
  };
}

function profileJson(
  analysis: ProductSemanticAnalysis | null,
  terms: StoredSemanticTerm[],
): Prisma.InputJsonValue {
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    analysis: analysis
      ? (analysis as unknown as Prisma.InputJsonObject)
      : null,
    terms: terms as unknown as Prisma.InputJsonArray,
  };
}
function dedupeTerms(terms: StoredSemanticTerm[]) {
  const result = new Map<string, StoredSemanticTerm>();
  for (const term of terms) {
    const key = `${term.kind}\u0000${term.normalizedValue}`;
    if (!result.has(key)) result.set(key, term);
  }
  return [...result.values()];
}

export function invalidateProductSemanticProfileCache(shop: string) {
  cache.delete(shop);
}

export async function replaceProductSemanticProfile(args: {
  shop: string;
  productId: string;
  analysis: ProductSemanticAnalysis | null;
  terms: StoredSemanticTerm[];
}) {
  const terms = dedupeTerms(args.terms);
  await db.aiSearchProductSemanticProfile.upsert({
    where: {
      shop_productId: {
        shop: args.shop,
        productId: args.productId,
      },
    },
    create: {
      shop: args.shop,
      productId: args.productId,
      schemaVersion: PROFILE_SCHEMA_VERSION,
      profile: profileJson(args.analysis, terms),
    },
    update: {
      schemaVersion: PROFILE_SCHEMA_VERSION,
      profile: profileJson(args.analysis, terms),
    },
  });
  invalidateProductSemanticProfileCache(args.shop);
  return terms.length;
}

export async function ensureProductSemanticTerms(args: {
  shop: string;
  productId: string;
  terms: StoredSemanticTerm[];
}) {
  const existing = await db.aiSearchProductSemanticProfile.findUnique({
    where: {
      shop_productId: {
        shop: args.shop,
        productId: args.productId,
      },
    },
    select: { profile: true },
  });
  const parsed = parseStoredSemanticProfile(existing?.profile);
  const merged = dedupeTerms([...parsed.terms, ...args.terms]);

  if (!existing || merged.length !== parsed.terms.length) {
    await db.aiSearchProductSemanticProfile.upsert({
      where: {
        shop_productId: {
          shop: args.shop,
          productId: args.productId,
        },
      },
      create: {
        shop: args.shop,
        productId: args.productId,
        schemaVersion: PROFILE_SCHEMA_VERSION,
        profile: profileJson(parsed.analysis, merged),
      },
      update: {
        schemaVersion: PROFILE_SCHEMA_VERSION,
        profile: profileJson(parsed.analysis, merged),
      },
    });
    invalidateProductSemanticProfileCache(args.shop);
  }

  return merged.length;
}

async function loadShopSemanticRowsUncached(shop: string) {
  const profiles = await db.aiSearchProductSemanticProfile.findMany({
    where: {
      shop,
      productRecord: {
        is: {
          searchable: true,
          hasVector: true,
        },
      },
    },
    select: {
      productId: true,
      profile: true,
      updatedAt: true,
    },
  });

  const rows: FlatSemanticRow[] = [];
  for (const record of profiles) {
    const parsed = parseStoredSemanticProfile(record.profile);
    for (const term of parsed.terms) {
      rows.push({
        productId: record.productId,
        updatedAt: record.updatedAt,
        ...term,
      });
    }
  }

  cache.set(shop, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    rows,
  });
  while (cache.size > 100) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
  return rows;
}
export async function loadShopSemanticRows(shop: string) {
  const cached = cache.get(shop);
  if (cached && cached.expiresAt > Date.now()) return cached.rows;

  const pending = pendingLoads.get(shop);
  if (pending) return pending;

  const task = loadShopSemanticRowsUncached(shop);
  pendingLoads.set(shop, task);
  try {
    return await task;
  } finally {
    if (pendingLoads.get(shop) === task) pendingLoads.delete(shop);
  }
}

export async function loadProductSemanticRows(
  shop: string,
  productIds: string[],
) {
  if (productIds.length === 0) return [];
  const wanted = new Set(productIds);
  const rows = await loadShopSemanticRows(shop);
  return rows.filter((row) => wanted.has(row.productId));
}

export async function findSemanticProductIds(args: {
  shop: string;
  kinds: string[];
  normalizedValue: string;
}) {
  const kinds = new Set(args.kinds);
  const rows = await loadShopSemanticRows(args.shop);
  return new Set(
    rows
      .filter(
        (row) =>
          kinds.has(row.kind) &&
          row.normalizedValue === args.normalizedValue,
      )
      .map((row) => row.productId),
  );
}

export async function getSemanticProfileForProduct(
  shop: string,
  productId: string,
) {
  const record = await db.aiSearchProductSemanticProfile.findUnique({
    where: { shop_productId: { shop, productId } },
    select: {
      productId: true,
      profile: true,
      schemaVersion: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!record) return null;
  return {
    ...record,
    parsed: parseStoredSemanticProfile(record.profile),
  };
}
