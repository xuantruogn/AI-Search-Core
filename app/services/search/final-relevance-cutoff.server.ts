type RetrievalSource = "SEMANTIC" | "SPARSE" | "LEXICAL" | "STRUCTURED";

type CutoffShape = {
  score: number;
  vectorSimilarity?: number;
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
  const sparseScores = shaped
    .map((result) => result.sparseScore)
    .filter((value): value is number => Number.isFinite(value) && value! > 0);
  const topSparse = sparseScores.length > 0 ? Math.max(...sparseScores) : 0;

  return shaped.filter((result) => {
    if (hasExactAuthority(result)) return true;

    const sources = uniqueSources(result);
    if (sources.size >= 2) return true;

    if (sources.has("SEMANTIC")) {
      const cosine = result.vectorSimilarity;
      return (
        typeof cosine === "number" &&
        Number.isFinite(cosine) &&
        cosine >= args.semanticThreshold
      );
    }

    if (sources.has("LEXICAL")) {
      // Token/handle lexical matches are useful direct lookup recall, but must
      // not become a generic discovery engine.
      return args.retrievalMode === "DIRECT";
    }

    if (sources.has("STRUCTURED")) {
      // Non-authoritative structured-only candidates should already have been
      // suppressed by hybrid fusion. Do not reopen them here.
      return false;
    }

    if (sources.has("SPARSE")) {
      const rank = result.sparseRank ?? Number.POSITIVE_INFINITY;
      const score = result.sparseScore ?? 0;
      const relative = topSparse > 0 ? score / topSparse : 0;

      if (args.retrievalMode === "DIRECT") {
        return rank <= 20 && relative >= 0.35;
      }

      // Natural-language discovery is dense-led. A sparse-only candidate must
      // be one of the very strongest lexical hits; otherwise it is tail filler.
      return rank <= 5 && relative >= 0.7;
    }

    return false;
  }) as T[];
}
