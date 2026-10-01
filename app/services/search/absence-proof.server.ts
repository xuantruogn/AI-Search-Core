import db from "../../db.server";
import { PRODUCT_ENRICHMENT_VERSION } from "../products/product-embedding-input.server";
import type { QueryConstraint, QueryPlan } from "./query-plan.server";
import { normalizeQueryText } from "./deterministic-query-parser.server";

export type AbsenceProofStatus =
  | "CERTAIN_NO_RESULT"
  | "HAS_CANDIDATES"
  | "UNKNOWN";

export type AbsenceProof = {
  status: AbsenceProofStatus;
  phase: "RAW" | "FINAL";
  reason: string;
  durationMs: number;
  candidateCount: number | null;
  coverageComplete: boolean;
  evidence: string[];
};

type ProofConstraint = {
  label: string;
  constraint: QueryConstraint;
  kinds: string[];
  requiresEnrichment: boolean;
};
function normalized(constraint: QueryConstraint) {
  return constraint.normalizedValue || normalizeQueryText(constraint.value);
}

function must(items: QueryConstraint[]) {
  return items.filter((item) => item.mode === "MUST");
}

function proofConstraints(plan: QueryPlan): ProofConstraint[] {
  return [
    ...must(plan.entities.identifiers).map((constraint) => ({
      label: "identifier",
      constraint,
      kinds: ["IDENTIFIER", "SKU", "BARCODE"],
      requiresEnrichment: false,
    })),
    ...must(plan.entities.models).map((constraint) => ({
      label: "model",
      constraint,
      kinds: ["MODEL"],
      requiresEnrichment: true,
    })),
    ...must(plan.entities.brands).map((constraint) => ({
      label: "brand",
      constraint,
      kinds: ["BRAND", "VENDOR"],
      requiresEnrichment: false,
    })),
    ...must(plan.compatibility)
      .filter((constraint) => constraint.confidence >= 0.99)
      .map((constraint) => ({
        label: "compatibility",
        constraint,
        kinds: ["COMPATIBILITY"],
        requiresEnrichment: true,
      })),
    // Audience, context and descriptive attributes are open-world semantic
    // signals. A product may satisfy "comfortable", "party", "rainy" etc.
    // without storing that exact normalized value, so they must never prove
    // CERTAIN_NO_RESULT.
    ...plan.measurements
      .filter(
        (item) =>
          item.mode === "MUST" &&
          item.confidence >= 0.99,
      )
      .map((constraint) => ({
        label: "measurement",
        constraint,
        kinds: ["MEASUREMENT", "VARIANT_OPTION", "ATTRIBUTE"],
        requiresEnrichment: true,
      })),
  ];
}

function intersect(left: Set<string>, right: Set<string>) {
  return new Set([...left].filter((value) => right.has(value)));
}
async function exactMatches(args: {
  shop: string;
  kinds: string[];
  value: string;
}) {
  // Query the indexed facet itself and intersect candidate IDs in memory.
  // Avoid a large productId IN (...) predicate here: it is unnecessary and
  // has caused intermittent empty-engine responses in Prisma/MySQL.
  const rows = await db.aiSearchShopContextTerm.findMany({
    where: {
      shop: args.shop,
      kind: { in: args.kinds },
      normalizedValue: args.value,
    },
    select: { productId: true },
    take: 50_000,
  });
  return new Set(rows.map((row) => row.productId));
}

async function canonicalCoverage(shop: string, searchableIds: string[]) {
  if (!searchableIds.length) return true;

  // Avoid Prisma groupBy + a large IN predicate here. On MySQL that path can
  // intermittently return an empty engine response under concurrent search
  // load. Read the shop's canonical rows once and compare coverage in memory.
  const rows = await db.aiSearchShopContextTerm.findMany({
    where: {
      shop,
      kind: "CANONICAL_PRODUCT_TYPE",
    },
    select: { productId: true },
    take: 50_000,
  });
  const covered = new Set(rows.map((row) => row.productId));
  return searchableIds.every((productId) => covered.has(productId));
}
async function enrichmentCoverage(shop: string, productIds: string[]) {
  if (!productIds.length) return true;
  const count = await db.aiSearchIndexedProduct.count({
    where: {
      shop,
      productId: { in: productIds },
      searchable: true,
      enrichmentStatus: "ENRICHED",
      enrichmentVersion: PRODUCT_ENRICHMENT_VERSION,
    },
  });
  return count === productIds.length;
}

export async function proveNoResult(args: {
  shop: string;
  plan: QueryPlan;
  phase: "RAW" | "FINAL";
}): Promise<AbsenceProof> {
  const startedAt = Date.now();
  const indexed = await db.aiSearchIndexedProduct.findMany({
    where: { shop: args.shop, searchable: true, hasVector: true },
    select: { productId: true },
  });
  const searchableIds = indexed.map((row) => row.productId);
  if (!searchableIds.length) {
    return {
      status: "CERTAIN_NO_RESULT",
      phase: args.phase,
      reason: "SEARCHABLE_CATALOG_EMPTY",
      durationMs: Date.now() - startedAt,
      candidateCount: 0,
      coverageComplete: true,
      evidence: ["searchableProducts=0"],
    };
  }

  let candidates = new Set(searchableIds);
  const evidence: string[] = [];
  const identities = must(args.plan.identities);
  const identityCoverageComplete = await canonicalCoverage(args.shop, searchableIds);
  const identityProofComplete =
    identityCoverageComplete &&
    identities.every((identity) => identity.confidence >= 0.99);

  for (const identity of identities) {
    const matches = await exactMatches({
      shop: args.shop,
      kinds: ["CANONICAL_PRODUCT_TYPE", "PRODUCT_TYPE", "ALIAS", "CATEGORY"],
      value: normalized(identity),
    });
    candidates = intersect(candidates, matches);
    evidence.push(`identity:${normalized(identity)}=${matches.size}`);
  }
  if (identities.length && candidates.size === 0) {
    return {
      status: identityProofComplete ? "CERTAIN_NO_RESULT" : "UNKNOWN",
      phase: args.phase,
      reason: identityProofComplete
        ? "IDENTITY_INTERSECTION_EMPTY"
        : "IDENTITY_COVERAGE_INCOMPLETE",
      durationMs: Date.now() - startedAt,
      candidateCount: 0,
      coverageComplete: identityProofComplete,
      evidence,
    };
  }

  for (const item of proofConstraints(args.plan)) {
    const candidateIds = [...candidates];
    const coverageComplete = item.requiresEnrichment
      ? await enrichmentCoverage(args.shop, candidateIds)
      : identityCoverageComplete;
    const matches = await exactMatches({
      shop: args.shop,
      kinds: item.kinds,
      value: normalized(item.constraint),
    });
    evidence.push(`${item.label}:${normalized(item.constraint)}=${matches.size}`);
    if (matches.size === 0) {
      return {
        status: coverageComplete ? "CERTAIN_NO_RESULT" : "UNKNOWN",
        phase: args.phase,
        reason: coverageComplete
          ? `${item.label.toUpperCase()}_INTERSECTION_EMPTY`
          : `${item.label.toUpperCase()}_COVERAGE_INCOMPLETE`,
        durationMs: Date.now() - startedAt,
        candidateCount: 0,
        coverageComplete,
        evidence,
      };
    }
    candidates = intersect(candidates, matches);
    if (candidates.size === 0) {
      return {
        status: coverageComplete ? "CERTAIN_NO_RESULT" : "UNKNOWN",
        phase: args.phase,
        reason: coverageComplete ? "MUST_INTERSECTION_EMPTY" : "MUST_COVERAGE_INCOMPLETE",
        durationMs: Date.now() - startedAt,
        candidateCount: 0,
        coverageComplete,
        evidence,
      };
    }
  }
  return {
    status: candidates.size < searchableIds.length ? "HAS_CANDIDATES" : "UNKNOWN",
    phase: args.phase,
    reason: candidates.size < searchableIds.length
      ? "PROVEN_CANDIDATE_SET_NON_EMPTY"
      : "NO_CLOSED_WORLD_CONSTRAINT",
    durationMs: Date.now() - startedAt,
    candidateCount: candidates.size,
    coverageComplete: identityCoverageComplete,
    evidence,
  };
}
