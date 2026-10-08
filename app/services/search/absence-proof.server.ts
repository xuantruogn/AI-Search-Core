import db from "../../db.server";
import { PRODUCT_ENRICHMENT_VERSION } from "../products/product-embedding-input.server";
import type { QueryConstraint, QueryPlan } from "./query-plan.server";
import { normalizeQueryText } from "./deterministic-query-parser.server";
import {
  countSemanticProductsForKind,
  findSemanticProductIds,
  semanticPayloadToken,
  loadShopSemanticRows,
} from "./product-semantic-profile.server";
import {
  countProductsBySemanticKind,
  countProductsMatchingSemanticGroups,
  getSemanticPayloadCoverage,
} from "./vector-store.server";

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

function proofEquivalenceKey(value: string) {
  return normalizeQueryText(value)
    .split(" ")
    .filter(Boolean)
    .map((token) => {
      if (token.length > 4 && token.endsWith("ies")) {
        return token.slice(0, -3) + "y";
      }
      if (
        token.length > 3 &&
        token.endsWith("s") &&
        !token.endsWith("ss") &&
        !token.endsWith("us") &&
        !token.endsWith("is")
      ) {
        return token.slice(0, -1);
      }
      return token;
    })
    .join(" ");
}

function dedupeProofConstraints(items: ProofConstraint[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.label}:${proofEquivalenceKey(normalized(item.constraint))}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function proofConstraints(plan: QueryPlan): ProofConstraint[] {
  return dedupeProofConstraints([
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
  ]);
}

function intersect(left: Set<string>, right: Set<string>) {
  return new Set([...left].filter((value) => right.has(value)));
}
async function exactMatches(args: {
  shop: string;
  kinds: string[];
  value: string;
}) {
  return findSemanticProductIds({
    shop: args.shop,
    kinds: args.kinds,
    normalizedValue: args.value,
  });
}

async function canonicalCoverage(shop: string, searchableCount: number) {
  if (searchableCount === 0) return true;
  const covered = await countSemanticProductsForKind(
    shop,
    "CANONICAL_PRODUCT_TYPE",
  );
  return covered === searchableCount;
}

async function enrichmentCoverage(
  shop: string,
  productIds: string[] | null,
  searchableCount: number,
) {
  const expected = productIds?.length ?? searchableCount;
  if (expected === 0) return true;
  const count = await db.aiSearchIndexedProduct.count({
    where: {
      shop,
      ...(productIds ? { productId: { in: productIds } } : {}),
      searchable: true,
      hasVector: true,
      enrichmentStatus: "ENRICHED",
      enrichmentVersion: PRODUCT_ENRICHMENT_VERSION,
    },
  });
  return count === expected;
}

/** Enrichment/payload completeness describes indexing, not source truth.
 * The current PSF has no source-field completeness manifest for LLM-enriched
 * model, compatibility or measurement facts. Missing values stay UNKNOWN.
 * Shopify identifiers/vendor can prove absence only with typed field coverage.
 */
async function closedWorldSourceCoverage(
  item: ProofConstraint,
  productIds: string[] | null,
  searchableCount: number,
  loadRows: () => ReturnType<typeof loadShopSemanticRows>,
) {
  if (item.requiresEnrichment) return false;
  if (!["CODE", "DICTIONARY"].includes(item.constraint.source)) return false;
  const rows = await loadRows();
  const scope = productIds ? new Set(productIds) : null;
  const covered = new Set(rows.filter((row) =>
    item.kinds.includes(row.kind) && (!scope || scope.has(row.productId)),
  ).map((row) => row.productId));
  return covered.size === (scope?.size ?? searchableCount);
}

export async function proveNoResult(args: {
  shop: string;
  plan: QueryPlan;
  phase: "RAW" | "FINAL";
}): Promise<AbsenceProof> {
  const startedAt = Date.now();
  const identities = must(args.plan.identities);
  const closedWorldConstraints = proofConstraints(args.plan);

  // Most searches contain no closed-world fact that can safely prove absence.
  // Exit before touching the catalog/profile cache instead of scanning it twice
  // (RAW + FINAL) for every ordinary semantic query.
  if (identities.length === 0 && closedWorldConstraints.length === 0) {
    return {
      status: "UNKNOWN",
      phase: args.phase,
      reason: "NO_CLOSED_WORLD_CONSTRAINT",
      durationMs: Date.now() - startedAt,
      candidateCount: null,
      coverageComplete: false,
      evidence: [],
    };
  }

  const searchableCount = await db.aiSearchIndexedProduct.count({
    where: { shop: args.shop, searchable: true, hasVector: true },
  });
  if (searchableCount === 0) {
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

  // Without a complete source-field manifest, LLM-enriched measurements,
  // compatibility and models cannot prove absence. When no target identity or
  // provable typed source fact remains, skip every catalog-wide profile scan
  // and Qdrant count; they cannot change UNKNOWN into certainty.
  const canProveTypedFact = closedWorldConstraints.some(
    (item) => !item.requiresEnrichment &&
      ["CODE", "DICTIONARY"].includes(item.constraint.source),
  );
  if (identities.length === 0 && !canProveTypedFact) {
    return {
      status: "UNKNOWN",
      phase: args.phase,
      reason: "NO_SOURCE_COMPLETE_CLOSED_WORLD_FACT",
      durationMs: Date.now() - startedAt,
      candidateCount: null,
      coverageComplete: false,
      evidence: [],
    };
  }

  const evidence: string[] = [];
  // Typed source coverage may be checked repeatedly within one proof.
  // Reuse the same profile load even when the catalog exceeds cache limits.
  let coverageRowsPromise: ReturnType<typeof loadShopSemanticRows> | null = null;
  const getCoverageRows = () => {
    coverageRowsPromise ??= loadShopSemanticRows(args.shop);
    return coverageRowsPromise;
  };

  let semanticPayloadCoverageComplete = false;
  try {
    const payloadCoverage = await getSemanticPayloadCoverage(args.shop);
    semanticPayloadCoverageComplete =
      payloadCoverage.complete &&
      payloadCoverage.registryCount === searchableCount;
  } catch {
    // The JSON semantic profile remains the authoritative fallback. Absence
    // proof must degrade to UNKNOWN/fallback work rather than fail search.
  }

  const identityCoverageComplete = identities.length
    ? semanticPayloadCoverageComplete
      ? (await countProductsBySemanticKind({
          shop: args.shop,
          kind: "CANONICAL_PRODUCT_TYPE",
        })) === searchableCount
      : await canonicalCoverage(args.shop, searchableCount)
    : true;
  const currentEnrichmentComplete = identities.length
    ? await enrichmentCoverage(args.shop, null, searchableCount)
    : true;
  const identityProofComplete =
    identityCoverageComplete &&
    currentEnrichmentComplete &&
    identities.every((identity) => identity.confidence >= 0.99);

  // When every searchable vector carries the current semantic payload, Qdrant
  // can prove intersections directly with indexed keyword filters. This avoids
  // materializing the shop's entire JSON semantic catalog just to answer an
  // exact closed-world question. Any Qdrant failure falls through to the
  // authoritative JSON path below.
  if (semanticPayloadCoverageComplete) {
    try {
      const groups: string[][] = [];
      let candidateCount = searchableCount;
      let cumulativeProofComplete =
        identities.length > 0 ? identityProofComplete : true;

      for (const identity of identities) {
        const value = normalized(identity);
        groups.push(
          ["CANONICAL_PRODUCT_TYPE", "PRODUCT_TYPE", "ALIAS", "CATEGORY"]
            .map((kind) => semanticPayloadToken(kind, value))
            .filter(Boolean),
        );
        candidateCount = await countProductsMatchingSemanticGroups({
          shop: args.shop,
          groups,
        });
        evidence.push(`identity:${value}=${candidateCount}`);
        if (candidateCount === 0) {
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
      }

      for (const item of closedWorldConstraints) {
        const coverageComplete = await closedWorldSourceCoverage(
          item, null, searchableCount, getCoverageRows,
        );

        cumulativeProofComplete =
          cumulativeProofComplete &&
          coverageComplete &&
          item.constraint.confidence >= 0.99;

        const value = normalized(item.constraint);
        groups.push(
          item.kinds
            .map((kind) => semanticPayloadToken(kind, value))
            .filter(Boolean),
        );
        candidateCount = await countProductsMatchingSemanticGroups({
          shop: args.shop,
          groups,
        });
        evidence.push(`${item.label}:${value}=${candidateCount}`);

        if (candidateCount === 0) {
          return {
            status: cumulativeProofComplete ? "CERTAIN_NO_RESULT" : "UNKNOWN",
            phase: args.phase,
            reason: cumulativeProofComplete
              ? `${item.label.toUpperCase()}_INTERSECTION_EMPTY`
              : `${item.label.toUpperCase()}_COVERAGE_INCOMPLETE`,
            durationMs: Date.now() - startedAt,
            candidateCount: 0,
            coverageComplete: cumulativeProofComplete,
            evidence,
          };
        }
      }

      return {
        status: groups.length > 0 ? "HAS_CANDIDATES" : "UNKNOWN",
        phase: args.phase,
        reason: groups.length > 0
          ? "PROVEN_CANDIDATE_SET_NON_EMPTY"
          : "NO_CLOSED_WORLD_CONSTRAINT",
        durationMs: Date.now() - startedAt,
        candidateCount: groups.length > 0 ? candidateCount : null,
        coverageComplete: cumulativeProofComplete,
        evidence,
      };
    } catch (error) {
      evidence.length = 0;
      console.warn("[AI Search][ABSENCE PROOF] semantic payload fallback", {
        shop: args.shop,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let candidates: Set<string> | null = null;
  let cumulativeProofComplete =
    identities.length > 0 ? identityProofComplete : true;

  for (const identity of identities) {
    const matches = await exactMatches({
      shop: args.shop,
      kinds: ["CANONICAL_PRODUCT_TYPE", "PRODUCT_TYPE", "ALIAS", "CATEGORY"],
      value: normalized(identity),
    });
    candidates = candidates ? intersect(candidates, matches) : matches;
    evidence.push(`identity:${normalized(identity)}=${matches.size}`);
    if (candidates.size === 0) {
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
  }

  for (const item of closedWorldConstraints) {
    const candidateIds = candidates ? [...candidates] : null;
    const coverageComplete = await closedWorldSourceCoverage(
      item, candidateIds, searchableCount, getCoverageRows,
    );
    cumulativeProofComplete =
      cumulativeProofComplete &&
      coverageComplete &&
      item.constraint.confidence >= 0.99;
    const matches = await exactMatches({
      shop: args.shop,
      kinds: item.kinds,
      value: normalized(item.constraint),
    });
    evidence.push(`${item.label}:${normalized(item.constraint)}=${matches.size}`);

    if (matches.size === 0) {
      return {
        status: cumulativeProofComplete ? "CERTAIN_NO_RESULT" : "UNKNOWN",
        phase: args.phase,
        reason: cumulativeProofComplete
          ? `${item.label.toUpperCase()}_INTERSECTION_EMPTY`
          : `${item.label.toUpperCase()}_COVERAGE_INCOMPLETE`,
        durationMs: Date.now() - startedAt,
        candidateCount: 0,
        coverageComplete: cumulativeProofComplete,
        evidence,
      };
    }

    candidates = candidates ? intersect(candidates, matches) : matches;
    if (candidates.size === 0) {
      return {
        status: cumulativeProofComplete ? "CERTAIN_NO_RESULT" : "UNKNOWN",
        phase: args.phase,
        reason: cumulativeProofComplete
          ? "MUST_INTERSECTION_EMPTY"
          : "MUST_COVERAGE_INCOMPLETE",
        durationMs: Date.now() - startedAt,
        candidateCount: 0,
        coverageComplete: cumulativeProofComplete,
        evidence,
      };
    }
  }

  return {
    status: candidates ? "HAS_CANDIDATES" : "UNKNOWN",
    phase: args.phase,
    reason: candidates
      ? "PROVEN_CANDIDATE_SET_NON_EMPTY"
      : "NO_CLOSED_WORLD_CONSTRAINT",
    durationMs: Date.now() - startedAt,
    candidateCount: candidates?.size ?? null,
    coverageComplete: cumulativeProofComplete,
    evidence,
  };
}
