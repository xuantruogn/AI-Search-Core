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
    if (hasExactAuthority(result)) return true;

    const sources = uniqueSources(result);
    const primaryDemandCosine = result.primaryVectorSimilarity;
    const hasPrimaryDemandEvidence =
      typeof primaryDemandCosine === "number" &&
      Number.isFinite(primaryDemandCosine) &&
      primaryDemandCosine >= args.semanticThreshold;

    if (sources.size >= 2) {
      // Lane agreement is corroboration, not proof of the whole request.
      // DISCOVERY and COMPLEMENT both carry open-world joint meaning in the
      // primary dense vector, so BM25/structured agreement cannot replace
      // full Demand/relation evidence. Exact authority was handled above.
      if (
        args.retrievalMode === "DISCOVERY" ||
        args.retrievalMode === "COMPLEMENT"
      ) {
        return sources.has("SEMANTIC") && hasPrimaryDemandEvidence;
      }
      return true;
    }

    if (sources.has("SEMANTIC")) {
      if (
        args.retrievalMode === "DISCOVERY" ||
        args.retrievalMode === "COMPLEMENT"
      ) {
        // Secondary expansion vectors are recall probes. A branch-only hit is
        // not final evidence that the product satisfies the complete shopper
        // Demand or the target/reference complement relation.
        return hasPrimaryDemandEvidence;
      }
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
      // BM25 is recall/corroboration, never truth by itself. DIRECT exact
      // authority has its own lexical/structured path above; open-world modes
      // require primary Semantic Demand evidence. A sparse-only candidate is
      // therefore never sufficient at the final precision gate.
      return false;
    }

    return false;
  }) as T[];
}
