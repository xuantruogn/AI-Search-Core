import {
  rewriteSearchQuery,
  type QueryRewriteResult,
} from "./query-rewriter.server";

import {
  applyShopContextToQuery,
} from "./shop-context-index.server";

type GptSettled =
  | {
      status: "success";
      value: QueryRewriteResult;
    }
  | {
      status: "error";
      error: unknown;
    };

export type ParallelQueryEnrichmentDiagnostics = {
  totalMs: number;
  codeMs: number;
  gptWaitMs: number;
  softWaitMs: number;

  gptOutcome:
    | "USED"
    | "SOFT_DEADLINE"
    | "GPT_FALLBACK"
    | "GPT_ERROR";

  gptCompletedWithinDeadline: boolean;

  gptFallbackReason:
    | string
    | null;

  novelSemanticTerms: string[];
};

export type ParallelQueryEnrichmentResult = {
  preparedRewrite: QueryRewriteResult;

  diagnostics:
    ParallelQueryEnrichmentDiagnostics;
};

const DEFAULT_GPT_SOFT_WAIT_MS =
  1000;

const MAX_GPT_SOFT_WAIT_MS =
  5000;

const MAX_NOVEL_SEMANTIC_TERMS =
  12;

function readGptSoftWaitMs(): number {
  const raw =
    Number.parseInt(
      process.env
        .AI_SEARCH_GPT_SOFT_WAIT_MS ??
        "",
      10,
    );

  if (
    !Number.isSafeInteger(raw) ||
    raw <= 0
  ) {
    return DEFAULT_GPT_SOFT_WAIT_MS;
  }

  return Math.min(
    raw,
    MAX_GPT_SOFT_WAIT_MS,
  );
}

function cleanMeaning(
  value: unknown,
): string {
  return String(
    value ?? "",
  )
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeMeaning(
  value: unknown,
): string {
  return cleanMeaning(
    value,
  )
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(
      /[^\p{L}\p{N}\s]/gu,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(
  values: readonly unknown[],
): string[] {
  const seen =
    new Set<string>();

  const result:
    string[] = [];

  for (
    const value
    of values
  ) {
    const clean =
      cleanMeaning(value);

    const normalized =
      normalizeMeaning(clean);

    if (
      !clean ||
      !normalized ||
      seen.has(normalized)
    ) {
      continue;
    }

    seen.add(normalized);

    result.push(clean);
  }

  return result;
}

function strings(
  value: unknown,
): string[] {
  if (
    !Array.isArray(value)
  ) {
    return [];
  }

  return uniqueStrings(
    value,
  );
}

function optionalString(
  value: unknown,
): string[] {
  const clean =
    cleanMeaning(value);

  return clean
    ? [clean]
    : [];
}

/**
 * Các field GPT được phép đóng góp
 * vào phần semantic enrichment.
 *
 * Không dùng price constraint ở đây.
 */
function collectGptSemanticTerms(
  rewrite: QueryRewriteResult,
): string[] {
  const analysis =
    rewrite.analysis;

  return uniqueStrings([
    ...optionalString(
      analysis.productType,
    ),

    ...optionalString(
      analysis
        .shopLanguageProductType,
    ),

    ...optionalString(
      analysis.category,
    ),

    ...strings(
      analysis.audience,
    ),

    ...strings(
      analysis.requiredAttributes,
    ),

    ...strings(
      analysis.optionalPreferences,
    ),

    ...strings(
      analysis.useCases,
    ),

    ...strings(
      analysis.compatibility,
    ),

    ...strings(
      analysis.entities,
    ),

    ...strings(
      analysis.attributes,
    ),

    ...strings(
      analysis.semanticExpansions,
    ),

    ...strings(
      analysis.shopLanguageTerms,
    ),

    ...strings(
      analysis.englishTerms,
    ),
  ]);
}

function collectCodeKnownMeanings(
  originalQuery: string,
  rewrite: QueryRewriteResult,
): Set<string> {
  const analysis =
    rewrite.analysis;

  const contextTerms =
    rewrite.context
      ?.selectedTerms
      ?.map(
        (
          term,
        ) =>
          term.value,
      ) ??
    [];

  const known =
    uniqueStrings([
      originalQuery,

      ...optionalString(
        analysis.productType,
      ),

      ...optionalString(
        analysis
          .shopLanguageProductType,
      ),

      ...optionalString(
        analysis.category,
      ),

      ...strings(
        analysis.audience,
      ),

      ...strings(
        analysis.requiredAttributes,
      ),

      ...strings(
        analysis.optionalPreferences,
      ),

      ...strings(
        analysis.useCases,
      ),

      ...strings(
        analysis.compatibility,
      ),

      ...strings(
        analysis.entities,
      ),

      ...strings(
        analysis.attributes,
      ),

      ...strings(
        analysis.semanticExpansions,
      ),

      ...strings(
        analysis.shopLanguageTerms,
      ),

      ...strings(
        analysis.englishTerms,
      ),

      ...contextTerms,
    ]);

  return new Set(
    known
      .map(
        normalizeMeaning,
      )
      .filter(Boolean),
  );
}

/**
 * Loại các phrase có vẻ là
 * constraint giá.
 *
 * Giá do price parser xử lý riêng.
 */
function looksLikePriceConstraint(
  value: string,
): boolean {
  const normalized =
    normalizeMeaning(
      value,
    );

  if (!normalized) {
    return false;
  }

  const hasPriceWord =
    /\b(gia|price|duoi|tren|tu|den|toi da|toi thieu|under|over|below|above)\b/u
      .test(
        normalized,
      );

  const hasMoneyNumber =
    /\b\d+\s*(?:k|nghin|ngan|trieu|m|vnd|usd|eur|gbp|jpy|dong)\b/u
      .test(
        normalized,
      );

  return (
    (
      hasPriceWord &&
      /\d/u.test(
        normalized,
      )
    ) ||
    hasMoneyNumber
  );
}

function collectNovelSemanticTerms(
  args: {
    originalQuery: string;

    codeRewrite:
      QueryRewriteResult;

    gptRewrite:
      QueryRewriteResult;
  },
): string[] {
  const known =
    collectCodeKnownMeanings(
      args.originalQuery,
      args.codeRewrite,
    );

  const novel:
    string[] = [];

  const gptTerms =
    collectGptSemanticTerms(
      args.gptRewrite,
    );

  for (
    const term
    of gptTerms
  ) {
    const normalized =
      normalizeMeaning(
        term,
      );

    if (
      !normalized ||
      known.has(
        normalized,
      )
    ) {
      continue;
    }

    if (
      looksLikePriceConstraint(
        term,
      )
    ) {
      continue;
    }

    known.add(
      normalized,
    );

    novel.push(
      term,
    );

    if (
      novel.length >=
      MAX_NOVEL_SEMANTIC_TERMS
    ) {
      break;
    }
  }

  return novel;
}

/**
 * Baseline chỉ dành cho nhánh code.
 *
 * Không gọi GPT.
 */
function buildCodeBaseline(
  query: string,
): QueryRewriteResult {
  const cleanQuery =
    query.trim();

  const baseline = {
    query:
      cleanQuery,

    rewritten:
      false,

    catalogRelevant:
      true,

    model:
      "code-baseline",

    fallbackReason:
      "CODE_BASELINE",

    analysis: {
      sortIntent:
        "RELEVANCE",

      intent:
        "unknown",

      detectedLanguage:
        "unknown",

      complexity:
        "COMPLEX",

      confidence:
        0,

      productType:
        "",

      shopLanguageProductType:
        "",

      category:
        "",

      brands:
        [],

      models:
        [],

      identifiers:
        [],

      audience:
        [],

      requiredAttributes:
        [],

      optionalPreferences:
        [],

      useCases:
        [],

      compatibility:
        [],

      entities:
        [],

      attributes:
        [],

      negativeTerms:
        [],

      semanticExpansions:
        [],

      shopLanguage:
        "unknown",

      shopLanguageTerms:
        [],

      englishTerms:
        [],

      matchedCatalogTerms:
        [],

      decisionReason:
        "Code-first baseline.",
    },

    timing: {
      cacheStatus:
        "BYPASS",

      complexityRoute:
        "COMPLEX",

      timeoutBudgetMs:
        0,

      normalizeCodeMs:
        0,

      settingsDbMs:
        0,

      cacheLookupCodeMs:
        0,

      pendingWaitMs:
        0,

      llmMs:
        0,

      inputTokens:
        null,

      outputTokens:
        null,

      responseParseCodeMs:
        0,

      cacheWriteCodeMs:
        0,

      otherCodeMs:
        0,
    },
  };

  /**
   * Baseline là object nội bộ do ta tự tạo
   * để cấp cho shop-context code.
   *
   * Dùng unknown -> QueryRewriteResult,
   * không dùng any.
   */
  return baseline as
    unknown as
    QueryRewriteResult;
}

function mergeAnalysis(
  codeRewrite:
    QueryRewriteResult,

  gptRewrite:
    QueryRewriteResult,
): QueryRewriteResult["analysis"] {
  const codeAnalysis =
    codeRewrite.analysis;

  const gptAnalysis =
    gptRewrite.analysis;

  const contextTerms =
    codeRewrite.context
      ?.selectedTerms
      ?.map(
        (
          term,
        ) =>
          term.value,
      ) ??
    [];

  return {
    ...codeAnalysis,
    ...gptAnalysis,

    matchedCatalogTerms:
      uniqueStrings([
        ...strings(
          codeAnalysis
            .matchedCatalogTerms,
        ),

        ...strings(
          gptAnalysis
            .matchedCatalogTerms,
        ),

        ...contextTerms,
      ]),

    decisionReason:
      gptAnalysis
        .decisionReason ||
      codeAnalysis
        .decisionReason ||
      "Parallel code and GPT enrichment.",
  };
}

function mergeCodeAndGpt(
  args: {
    codeRewrite:
      QueryRewriteResult;

    gptRewrite:
      QueryRewriteResult;

    novelTerms:
      string[];
  },
): QueryRewriteResult {
  const codeQuery =
    args.codeRewrite
      .query
      .trim();

  const enrichmentLine =
    args.novelTerms.length >
    0
      ? [
          "LLM semantic enrichment:",
          args.novelTerms.join(
            " | ",
          ),
        ].join(" ")
      : "";

  const mergedQuery =
    [
      codeQuery,
      enrichmentLine,
    ]
      .filter(Boolean)
      .join("\n");

  return {
    ...args.codeRewrite,

    query:
      mergedQuery,

    rewritten:
      args.codeRewrite
        .rewritten ||
      args.novelTerms.length >
        0,

    catalogRelevant:
      args.codeRewrite
        .catalogRelevant ||
      args.gptRewrite
        .catalogRelevant,

    model:
      args.gptRewrite.model,

    fallbackReason:
      null,

    analysis:
      mergeAnalysis(
        args.codeRewrite,
        args.gptRewrite,
      ),

    /**
     * Context thật của shop
     * luôn do code quyết định.
     */
    context:
      args.codeRewrite.context,

    timing:
      args.gptRewrite.timing,
  };
}

function codeOnlyResult(
  codeRewrite:
    QueryRewriteResult,

  fallbackReason:
    string,
): QueryRewriteResult {
  return {
    ...codeRewrite,

    model:
      "code-first",

    fallbackReason,
  };
}

function delay(
  ms: number,
): Promise<"deadline"> {
  return new Promise(
    (
      resolve,
    ) => {
      setTimeout(
        () => {
          resolve(
            "deadline",
          );
        },
        ms,
      );
    },
  );
}

/**
 * Query
 *
 *      ├──── Code + Shop Context
 *      │
 *      └──── GPT
 *
 * Hai nhánh chạy song song.
 *
 * GPT chỉ được phép giữ critical path
 * tối đa softWaitMs.
 */
export async function prepareParallelSearchRewrite(
  args: {
    shop: string;
    query: string;
  },
): Promise<
  ParallelQueryEnrichmentResult
> {
  const startedAt =
    Date.now();

  const softWaitMs =
    readGptSoftWaitMs();

  const cleanQuery =
    args.query.trim();

  /**
   * ========================================================
   * START GPT
   * ========================================================
   */
  const gptPromise:
    Promise<GptSettled> =
    rewriteSearchQuery({
      shop:
        args.shop,

      query:
        cleanQuery,
    }).then(
      (
        value,
      ): GptSettled => ({
        status:
          "success",

        value,
      }),

      (
        error:
          unknown,
      ): GptSettled => ({
        status:
          "error",

        error,
      }),
    );

  /**
   * ========================================================
   * START CODE
   * ========================================================
   */
  const codeStartedAt =
    Date.now();

  const codePromise =
    applyShopContextToQuery({
      shop:
        args.shop,

      originalQuery:
        cleanQuery,

      rewrite:
        buildCodeBaseline(
          cleanQuery,
        ),
    });

  const codeRewrite =
    await codePromise;

  const codeMs =
    Date.now() -
    codeStartedAt;

  /**
   * Budget GPT tính từ lúc cả
   * hai nhánh bắt đầu.
   */
  const elapsedMs =
    Date.now() -
    startedAt;

  const remainingWaitMs =
    Math.max(
      0,
      softWaitMs -
        elapsedMs,
    );

  const gptWaitStartedAt =
    Date.now();

  const raced:
    GptSettled |
    "deadline" =
    remainingWaitMs >
    0
      ? await Promise.race([
          gptPromise,

          delay(
            remainingWaitMs,
          ),
        ])
      : "deadline";

  const gptWaitMs =
    Date.now() -
    gptWaitStartedAt;

  /**
   * ========================================================
   * GPT QUÁ CHẬM
   * ========================================================
   */
  if (
    raced ===
    "deadline"
  ) {
    console.log(
      "[AI Search][Parallel Enrichment] GPT soft deadline",
      {
        shop:
          args.shop,

        codeMs,

        gptWaitMs,

        softWaitMs,

        totalMs:
          Date.now() -
          startedAt,
      },
    );

    return {
      preparedRewrite:
        codeOnlyResult(
          codeRewrite,
          "LLM_SOFT_DEADLINE",
        ),

      diagnostics: {
        totalMs:
          Date.now() -
          startedAt,

        codeMs,

        gptWaitMs,

        softWaitMs,

        gptOutcome:
          "SOFT_DEADLINE",

        gptCompletedWithinDeadline:
          false,

        gptFallbackReason:
          "LLM_SOFT_DEADLINE",

        novelSemanticTerms:
          [],
      },
    };
  }

  /**
   * ========================================================
   * GPT ERROR
   * ========================================================
   */
  if (
    raced.status ===
    "error"
  ) {
    console.warn(
      "[AI Search][Parallel Enrichment] GPT failed",
      {
        shop:
          args.shop,

        codeMs,

        gptWaitMs,

        error:
          raced.error
            instanceof Error
            ? raced.error.message
            : String(
                raced.error,
              ),
      },
    );

    return {
      preparedRewrite:
        codeOnlyResult(
          codeRewrite,
          "LLM_ERROR",
        ),

      diagnostics: {
        totalMs:
          Date.now() -
          startedAt,

        codeMs,

        gptWaitMs,

        softWaitMs,

        gptOutcome:
          "GPT_ERROR",

        gptCompletedWithinDeadline:
          true,

        gptFallbackReason:
          "LLM_ERROR",

        novelSemanticTerms:
          [],
      },
    };
  }

  const gptRewrite =
    raced.value;

  /**
   * GPT service có thể tự fallback
   * khi API lỗi.
   */
  if (
    gptRewrite.fallbackReason
  ) {
    return {
      preparedRewrite:
        codeOnlyResult(
          codeRewrite,
          gptRewrite
            .fallbackReason,
        ),

      diagnostics: {
        totalMs:
          Date.now() -
          startedAt,

        codeMs,

        gptWaitMs,

        softWaitMs,

        gptOutcome:
          "GPT_FALLBACK",

        gptCompletedWithinDeadline:
          true,

        gptFallbackReason:
          gptRewrite
            .fallbackReason,

        novelSemanticTerms:
          [],
      },
    };
  }

  /**
   * ========================================================
   * GPT THÀNH CÔNG
   * ========================================================
   *
   * Chỉ lấy semantic mới.
   */
  const novelSemanticTerms =
    collectNovelSemanticTerms({
      originalQuery:
        cleanQuery,

      codeRewrite,

      gptRewrite,
    });

  const preparedRewrite =
    mergeCodeAndGpt({
      codeRewrite,

      gptRewrite,

      novelTerms:
        novelSemanticTerms,
    });

  console.log(
    "[AI Search][Parallel Enrichment] merged",
    {
      shop:
        args.shop,

      codeMs,

      gptWaitMs,

      softWaitMs,

      novelSemanticTermCount:
        novelSemanticTerms.length,

      novelSemanticTerms,

      totalMs:
        Date.now() -
        startedAt,
    },
  );

  return {
    preparedRewrite,

    diagnostics: {
      totalMs:
        Date.now() -
        startedAt,

      codeMs,

      gptWaitMs,

      softWaitMs,

      gptOutcome:
        "USED",

      gptCompletedWithinDeadline:
        true,

      gptFallbackReason:
        null,

      novelSemanticTerms,
    },
  };
}