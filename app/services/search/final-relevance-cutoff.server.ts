type RetrievalSource = "SEMANTIC" | "SPARSE" | "LEXICAL" | "STRUCTURED";

type CutoffShape = {
  score: number;
  vectorSimilarity?: number;
  /** Cosine against the primary full Semantic Demand embedding. */
  primaryVectorSimilarity?: number;
  sparseScore?: number;
  sparseRank?: number;
  lexicalMatchType?: "EXACT_TITLE" | "TITLE_PHRASE" | "TITLE_TOKENS" | "HANDLE";
  structuredAnchorKinds?: string[];
  structuredMatchedKinds?: string[];
  structuredGuardRescue?: boolean;
  structuredExactCanonicalIdentity?: boolean;
  retrievalSources?: RetrievalSource[];
};

const CLOSED_WORLD = new Set([
  "IDENTIFIER",
  "MODEL",
  "COMPATIBILITY",
  "MEASUREMENT",
]);

function hasExactAuthority(result: CutoffShape) {
  if (
    result.lexicalMatchType === "EXACT_TITLE" ||
    result.lexicalMatchType === "TITLE_PHRASE"
  ) {
    return true;
  }
  if ((result.structuredAnchorKinds ?? []).some((kind) => CLOSED_WORLD.has(kind))) {
    return true;
  }
  return Boolean(
    result.structuredGuardRescue ||
      (
        result.structuredExactCanonicalIdentity &&
        (result.structuredMatchedKinds?.length ?? 0) >= 2
      ),
  );
}

function uniqueSources(result: CutoffShape) {
  return new Set(result.retrievalSources ?? []);
}

/**
 * Final precision gate after PSF validation/evidence reranking.
 *
 * Dense retrieval already owns its absolute cosine threshold. This gate mainly
 * prevents a sparse-only tail from filling result pages after RRF while
 * preserving exact authority and multi-lane confirmation.
 */
export function applyFinalRelevanceCutoff<T extends { score: number }>(args: {
  results: T[];
  retrievalMode: "DIRECT" | "DISCOVERY" | "COMPLEMENT";
  semanticThreshold: number;
}) {
  if (args.results.length === 0) return args.results;

  const shaped = args.results as Array<T & CutoffShape>;
  return shaped.filter((result) => {
    // Exact lookup authority has already been target/fact validated upstream.
    // In open-world modes it proves only a component or reference, not the
    // full need/relation, so it cannot replace primary Demand evidence.
    if (args.retrievalMode === "DIRECT" && hasExactAuthority(result)) return true;

    const sources = uniqueSources(result);
    const primaryDemandCosine = result.primaryVectorSimilarity;
    return sources.has("SEMANTIC") &&
      typeof primaryDemandCosine === "number" &&
      Number.isFinite(primaryDemandCosine) &&
      primaryDemandCosine >= args.semanticThreshold;
  }) as T[];
}
