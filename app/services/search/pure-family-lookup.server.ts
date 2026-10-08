import { listSearchableIndexedProducts } from "../commerce/indexed-products.server";
import { normalizeQueryText, parseDeterministicQuery } from "./deterministic-query-parser.server";
import { scanShopSemanticProfiles } from "./product-semantic-profile.server";
import { typedProductFamilyMatches } from "./structured-candidate-retrieval.server";
import { classifyFamilyProduct, queryFamilyFromSource, type FamilyGroup } from "./product-family-taxonomy.server";
import type { QueryPlan } from "./query-plan.server";
import type { QueryRewriteResult } from "./query-rewriter.server";
import type { SearchResult } from "./semantic-search.server";

/**
 * Complete, evidence-only family lookup. Dense/BM25 candidate limits must never
 * decide the membership or total of a genuinely family-only query.
 *
 * This lane intentionally uses the existing indexed registry policy:
 * profiles are streamed only for searchable products with usable vectors.
 * Missing/untrusted family evidence falls back to hybrid retrieval.
 */
export type PureFamilyTarget = {
  canonical: string;
  broadCategory: boolean;
  /** Explicit source-language broad family, independent of LLM paraphrase. */
  taxonomyGroup?: FamilyGroup;
};

const BROAD_CATEGORY_IDENTITIES = new Set(["clothing", "clothes", "apparel"]);

function noDemandQualifiers(rewrite: QueryRewriteResult) {
  const demand = rewrite.analysis.semanticDemand;
  if (!demand) return true;
  return [
    demand.desiredOutcomes, demand.useCases, demand.contexts, demand.qualities,
    demand.audience, demand.styles, demand.negativeConstraints,
    demand.exactConstraints,
  ].every((axis) => axis.length === 0);
}

export function classifyPureFamilyLookup(
  plan: QueryPlan | null,
  rewrite: QueryRewriteResult,
  rawPlan: QueryPlan | null = plan,
): PureFamilyTarget | null {
  if (!plan || plan.retrievalMode === "COMPLEMENT") return null;
  const source = normalizeQueryText(plan.rawQuery);
  if (!source) return null;
  const sourceTaxonomyGroup = queryFamilyFromSource(plan.rawQuery);

  const parsed = parseDeterministicQuery(plan.rawQuery);
  if (parsed.price || parsed.measurements.length || parsed.compatibility.length ||
      parsed.negatives.length || parsed.marketPreference !== "ANY" ||
      parsed.sort.field !== "RELEVANCE" || parsed.relation !== "SINGLE" ||
      parsed.hasComplexRelation || parsed.hasConflictingConstraints) return null;
  // Source is an exact, standalone family word (e.g. váy, áo, xe).
  // A second LLM pass must not collapse váy into Dress alone or invent a
  // clothing style that silently suppresses other genuine family members.
  // Shopper-origin constraints were already checked against the raw plan and
  // deterministic parser above; this path never applies to "váy đỏ".
  if (sourceTaxonomyGroup) {
    return {
      canonical: sourceTaxonomyGroup,
      broadCategory: false,
      taxonomyGroup: sourceTaxonomyGroup,
    };
  }
  // The remaining families are not exact source-owned bridge phrases, so
  // a dictionary/LLM modifier can still mean the shopper supplied constraints.
  // For exact "váy"/"áo"/"xe" the original source contains only the family;
  // a low-confidence TAG/ATTRIBUTE dictionary hit must not suppress lookup.
  if (rawPlan && (
    rawPlan.attributes.length || rawPlan.contexts.length || rawPlan.audiences.length ||
    rawPlan.measurements.length || rawPlan.compatibility.length ||
    rawPlan.entities.brands.length || rawPlan.entities.models.length ||
    rawPlan.entities.identifiers.length ||
    (rawPlan.identities.length > 0 && rawPlan.unresolvedSegments.length > 0)
  )) return null;
  if (!noDemandQualifiers(rewrite)) return null;
  if (plan.attributes.length || plan.measurements.length || plan.audiences.length ||
      plan.contexts.length || plan.compatibility.length ||
      plan.entities.brands.length || plan.entities.models.length ||
      plan.entities.identifiers.length) return null;

  // One complete source-aligned family, never a substring found within a
  // qualified request ("winter clothing", "black bicycle", "shirt size L").
  const sourceAligned = (rewrite.analysis.semanticMandatoryConcepts ?? [])
    .filter((concept) => normalizeQueryText(concept.source) === source)
    .map((concept) => concept.target);
  const matchedSourceTerms = plan.resolvedSegments
    .filter((span) => ["PRODUCT_TYPE", "ALIAS", "CATEGORY"].includes(span.field) &&
      normalizeQueryText(span.text) === source)
    .map((span) => span.canonicalValue);
  const directIdentity = plan.identities
    .filter((item) => item.mode !== "MUST_NOT" &&
      normalizeQueryText(item.value) === source)
    .map((item) => item.value);
  const targets = [...new Set([...sourceAligned, ...matchedSourceTerms, ...directIdentity]
    .map((value) => normalizeQueryText(value)).filter(Boolean))];
  if (targets.length !== 1) return null;

  const target = targets[0];
  if (plan.retrievalMode === "DISCOVERY" && !BROAD_CATEGORY_IDENTITIES.has(target)) return null;
  // The merged two-pass plan may contain a canonical translated identity
  // span as well as the source span. Permit that ONE source-aligned translation,
  // but never permit an extra attribute/context or sibling class.
  const permittedRawSegments = plan.resolvedSegments.every((span) =>
    ["PRODUCT_TYPE", "ALIAS", "CATEGORY"].includes(span.field) &&
    (normalizeQueryText(span.text) === source ||
      (sourceAligned.length === 1 && normalizeQueryText(span.canonicalValue) === target))
  );
  if (!permittedRawSegments) return null;
  // An unresolved source remainder is valid only if the LLM explicitly
  // translated the ENTIRE raw phrase to this single canonical target.
  if (plan.unresolvedSegments.length > 0 && sourceAligned.length !== 1) return null;
  if (plan.identities.length > 1) return null;
  // Clothes/clothing share a canonical taxonomy parent; this is a trusted
  // identity synonym, not an inferred set of product subtypes.
  const canonical = target === "clothes" ? "clothing" : target;
  return { canonical, broadCategory: BROAD_CATEGORY_IDENTITIES.has(target) };
}

type FamilyTerm = { kind: string; value: string };
function categoryPathMatches(value: string, target: string) {
  return value.split(/\s*(?:>|\/|»)\s*/).some((part) =>
    typedProductFamilyMatches(part, target) &&
    normalizeQueryText(part).split(" ").length <= normalizeQueryText(target).split(" ").length
  );
}

export function classifyVerifiedFamilyMember(
  terms: FamilyTerm[],
  target: PureFamilyTarget,
): "EXACT" | "SUBTYPE" | "CATEGORY" | null {
  // The exact sold-item canonical type outranks a loose merchant productType.
  // A helmet with productType=Bicycle is still a helmet, not a bicycle.
  const canonical = terms.filter((term) => term.kind === "CANONICAL_PRODUCT_TYPE");
  const typed = canonical.length > 0 ? canonical
    : terms.filter((term) => term.kind === "PRODUCT_TYPE");
  const taxonomyPaths = terms
    .filter((term) => term.kind === "SHOPIFY_CATEGORY_PATH")
    .map((term) => term.value);
  const evidence = {
    canonicalTypes: canonical.map((term) => term.value),
    merchantTypes: terms.filter((term) => term.kind === "PRODUCT_TYPE").map((term) => term.value),
    shopifyCategoryPaths: taxonomyPaths,
  };
  if (target.taxonomyGroup) {
    const verdict = classifyFamilyProduct(evidence, target.taxonomyGroup);
    if (!verdict.match) return null;
    return verdict.reason === "SHOPIFY_CATEGORY" ? "CATEGORY" : "SUBTYPE";
  }

  // For exact bicycle/dress/skirt terms, a standardized Shopify category
  // can prove membership even when the LLM did not create a canonical type.
  const standardLeafGroup: FamilyGroup | null =
    ["bicycle", "dress", "skirt"].includes(normalizeQueryText(target.canonical))
      ? normalizeQueryText(target.canonical) as FamilyGroup
      : null;
  if (standardLeafGroup && taxonomyPaths.length > 0) {
    const verdict = classifyFamilyProduct(evidence, standardLeafGroup);
    if (verdict.match && verdict.reason === "SHOPIFY_CATEGORY") return "CATEGORY";
    if (!verdict.match && verdict.reason === "CONTRADICTION") return null;
  }
  if (!typed.length) return null;
  const exact = typed.some((term) =>
    normalizeQueryText(term.value) === normalizeQueryText(target.canonical)
  );
  if (exact) return "EXACT";
  if (typed.some((term) =>
    typedProductFamilyMatches(term.value, target.canonical)
  )) return "SUBTYPE";
  // Only an explicitly broad category can inherit Shopify's typed
  // taxonomy. A bicycle accessory with CATEGORY=bicycle is still not a bicycle.
  if (target.broadCategory && terms.some((term) =>
    term.kind === "CATEGORY" && categoryPathMatches(term.value, target.canonical)
  )) return "CATEGORY";
  return null;
}

export type FamilyCoverage = {
  target: PureFamilyTarget;
  scannedProfiles: number;
  matchedProfiles: number;
  searchableProducts: number;
  /** Matches backed by standard Shopify category vs product type. */
  categoryMatches: number;
  /** Index-eligible profiles lacking any typed source for family membership. */
  missingFamilyEvidence: number;
  results: SearchResult[];
};

export async function retrieveCompleteFamilyCandidates(args: {
  shop: string;
  plan: QueryPlan | null;
  rewrite: QueryRewriteResult;
  rawPlan?: QueryPlan | null;
}, dependencies: {
  scanProfiles?: typeof scanShopSemanticProfiles;
  findRegistry?: typeof listSearchableIndexedProducts;
} = {}): Promise<FamilyCoverage | null> {
  const target = classifyPureFamilyLookup(args.plan, args.rewrite, args.rawPlan ?? args.plan);
  if (!target) return null;
  const matched: Array<{ productId: string; grade: "EXACT" | "SUBTYPE" | "CATEGORY" }> = [];
  let scannedProfiles = 0;
  let categoryMatches = 0;
  let missingFamilyEvidence = 0;
  await (dependencies.scanProfiles ?? scanShopSemanticProfiles)(args.shop, ({ productId, terms }) => {
    scannedProfiles += 1;
    if (!terms.some((term) => [
      "CANONICAL_PRODUCT_TYPE", "PRODUCT_TYPE", "SHOPIFY_CATEGORY_PATH",
    ].includes(term.kind))) missingFamilyEvidence += 1;
    const grade = classifyVerifiedFamilyMember(terms, target);
    if (grade) {
      if (grade === "CATEGORY") categoryMatches += 1;
      matched.push({ productId, grade });
    }
  });
  // Do not use zero source-backed matches to prove absence: incomplete catalog
  // taxonomy should still get the ordinary hybrid search opportunity.
  if (!matched.length) return null;

  const registry = new Map<string, { productId: string; title: string; handle: string }>();
  for (let offset = 0; offset < matched.length; offset += 300) {
    const batch = await (dependencies.findRegistry ?? listSearchableIndexedProducts)(
      args.shop, matched.slice(offset, offset + 300).map((row) => row.productId),
    );
    for (const row of batch) registry.set(row.productId, row);
  }

  const weight = { EXACT: 0.96, SUBTYPE: 0.92, CATEGORY: 0.86 } as const;
  const results = matched.flatMap(({ productId, grade }) => {
    const row = registry.get(productId);
    return row ? [{
      productId,
      handle: row.handle,
      title: row.title,
      score: weight[grade],
      structuredExactCanonicalIdentity: true,
      structuredMatchedKinds: ["PRODUCT_TYPE"],
      structuredGuardRescue: true,
      retrievalSources: ["STRUCTURED" as const],
    }] : [];
  }).sort((a, b) => b.score - a.score ||
    a.title.localeCompare(b.title) ||
    a.productId.localeCompare(b.productId));

  return {
    target,
    scannedProfiles,
    matchedProfiles: matched.length,
    searchableProducts: results.length,
    categoryMatches,
    missingFamilyEvidence,
    results,
  };
}
