import { proveNoResult, type AbsenceProof } from "./absence-proof.server";
import { buildQueryPlan } from "./query-planner.server";
import {
  buildQuerySemanticProfile,
  type QuerySemanticProfile,
} from "./query-semantic-profile.server";
import { queryPlanToLegacyRewrite } from "./legacy-query-rewrite-adapter.server";
import { rewriteSearchQuery } from "./query-rewriter.server";
import type { QueryPlan } from "./query-plan.server";

async function safeProveNoResult(args: {
  shop: string;
  plan: QueryPlan;
  phase: "RAW" | "FINAL";
}): Promise<AbsenceProof> {
  try {
    return await proveNoResult(args);
  } catch (error) {
    console.warn("[AI Search][ABSENCE PROOF] verifier failed open", {
      shop: args.shop,
      phase: args.phase,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      status: "UNKNOWN",
      phase: args.phase,
      reason: "VERIFIER_ERROR_FAIL_OPEN",
      durationMs: 0,
      candidateCount: null,
      coverageComplete: false,
      evidence: [],
    };
  }
}

export type ParallelQueryPipelineResult = {
  rawPlan: QueryPlan;
  profile: QuerySemanticProfile | null;
  rawProof: AbsenceProof;
  finalProof: Promise<AbsenceProof> | null;
  earlyNoResult: boolean;
  timing: {
    rawPlanMs: number;
    waitForRawProofMs: number;
    llmAndPass2Ms: number;
    totalMs: number;
  };
};
export async function prepareParallelQueryPipeline(args: {
  shop: string;
  query: string;
  searchLanguage: string | null;
}): Promise<ParallelQueryPipelineResult> {
  const startedAt = Date.now();
  const rawPlanStartedAt = Date.now();

  const rawPlanPromise = buildQueryPlan(args.shop, args.query);

  const rawProofPromise = rawPlanPromise.then((plan) =>
    safeProveNoResult({
      shop: args.shop,
      plan,
      phase: "RAW",
    }),
  );
  const rawPlan = await rawPlanPromise;
  const rawPlanMs = Date.now() - rawPlanStartedAt;

  const requiresLlm =
    rawPlan.route === "LIGHT_LLM" ||
    rawPlan.route === "FULL_LLM";

  // Start interpretation as soon as the deterministic plan is known. The
  // closed-world absence proof and LLM do independent work, so serializing them
  // adds latency to every LIGHT/FULL query. If the proof wins with a certain
  // empty result, the in-flight LLM is simply ignored.
  const llmStartedAt = requiresLlm ? Date.now() : 0;
  const llmPromise = requiresLlm
    ? rewriteSearchQuery({
        shop: args.shop,
        query: args.query,
        searchLanguage: args.searchLanguage,
      })
    : null;

  const rawProofWaitStartedAt = Date.now();
  const rawProof = await rawProofPromise;
  const waitForRawProofMs = Date.now() - rawProofWaitStartedAt;

  if (rawProof.status === "CERTAIN_NO_RESULT") {
    void llmPromise?.catch(() => undefined);
    return {
      rawPlan,
      profile: null,
      rawProof,
      finalProof: null,
      earlyNoResult: true,
      timing: {
        rawPlanMs,
        waitForRawProofMs,
        llmAndPass2Ms: 0,
        totalMs: Date.now() - startedAt,
      },
    };
  }

  if (!requiresLlm) {
    const rewrite = queryPlanToLegacyRewrite(rawPlan, args.query);
    const profile: QuerySemanticProfile = {
      rawPlan,
      expandedPlan: rawPlan,
      finalPlan: rawPlan,
      rewrite,
      embeddingInput: rewrite.query,
    };
    return {
      rawPlan,
      profile,
      rawProof,
      finalProof: safeProveNoResult({
        shop: args.shop,
        plan: rawPlan,
        phase: "FINAL",
      }),
      earlyNoResult: false,
      timing: {
        rawPlanMs,
        waitForRawProofMs,
        llmAndPass2Ms: 0,
        totalMs: Date.now() - startedAt,
      },
    };
  }

  const llm = await llmPromise!;
  const expandedPlan = llm.fallbackReason
    ? rawPlan
    : await buildQueryPlan(args.shop, llm.query);

  const profile = buildQuerySemanticProfile({
    originalQuery: args.query,
    rawPlan,
    expandedPlan,
    llm,
  });
  const llmAndPass2Ms = Date.now() - llmStartedAt;

  return {
    rawPlan,
    profile,
    rawProof,
    finalProof: safeProveNoResult({
      shop: args.shop,
      plan: profile.finalPlan,
      phase: "FINAL",
    }),
    earlyNoResult: false,
    timing: {
      rawPlanMs,
      waitForRawProofMs,
      llmAndPass2Ms,
      totalMs: Date.now() - startedAt,
    },
  };
}
