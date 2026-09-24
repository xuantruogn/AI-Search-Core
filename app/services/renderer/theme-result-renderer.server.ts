import type {
  ThemeArgumentValue,
  ThemeMapV4,
  ThemeMountRecipe,
  ThemeRendererCandidate,
} from "../theme/theme-map-v4.types";
import {
  parseLiquidDocument,
  type LiquidToken,
} from "../theme/liquid-ast.server";

export interface ThemeRenderProduct {
  productId?: string;
  handle: string;
}

export interface ThemeResultRenderPlan {
  liquid: string;
  candidateId: string;
  candidate: ThemeRendererCandidate;
  mount: ThemeMountRecipe;
  handles: string[];
  productCount: number;
}

const ALL_PRODUCTS_PAGE_LIMIT = 20;

type SnippetCommand =
  | "render"
  | "include";

interface SnippetInvocation {
  command: SnippetCommand;
  snippet: string;
  source: string;
}

function escapeRegExp(
  value: string,
): string {
  return value.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
}

function assertLiquidIdentifier(
  value: string,
  errorCode: string,
): string {
  const normalized =
    value.trim();

  if (
    !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(
      normalized,
    )
  ) {
    throw new Error(
      errorCode,
    );
  }

  return normalized;
}

function normalizeSnippetName(
  value: string,
): string {
  const normalized =
    value
      .trim()
      .replace(
        /^snippets\//i,
        "",
      )
      .replace(
        /\.liquid$/i,
        "",
      );

  if (
    !normalized ||
    normalized.includes("..") ||
    !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(
      normalized,
    )
  ) {
    throw new Error(
      "THEME_RENDER_INVALID_SNIPPET_NAME",
    );
  }

  return normalized;
}

function serializeLiquidValue(
  value: ThemeArgumentValue,
): string {
  if (value === null) {
    return "nil";
  }

  if (
    typeof value ===
    "boolean"
  ) {
    return value
      ? "true"
      : "false";
  }

  if (
    typeof value ===
    "number"
  ) {
    if (
      !Number.isFinite(
        value,
      )
    ) {
      throw new Error(
        "THEME_RENDER_NON_FINITE_ARGUMENT",
      );
    }

    return String(
      value,
    );
  }

  return `"${value
    .replace(
      /\\/g,
      "\\\\",
    )
    .replace(
      /"/g,
      '\\"',
    )
    .replace(
      /\r/g,
      "\\r",
    )
    .replace(
      /\n/g,
      "\\n",
    )}"`;
}

function nearestCaseAncestor(token: LiquidToken): number | undefined {
  for (let index = token.liquidAncestors.length - 1; index >= 0; index--) {
    const frame = token.liquidAncestors[index];
    if (frame.name === "case") return frame.tokenIndex;
  }
  return undefined;
}

/** Search-result object_type is not a property of all_products Product. */
function extractKnownProductBranch(source: string, sourceVariable: string): string {
  const safeVariable = assertLiquidIdentifier(
    sourceVariable,
    "THEME_RENDER_INVALID_PRODUCT_VARIABLE",
  );
  const document = parseLiquidDocument(source);
  const expectedExpression = `${safeVariable}.object_type`;

  for (const token of document.tokens) {
    if (
      token.kind !== "LIQUID_TAG" ||
      token.name !== "case" ||
      (token.markup ?? "").replace(/\s+/g, "") !== expectedExpression
    ) continue;

    const endCase = token.matchingTokenIndex === undefined
      ? undefined
      : document.tokens[token.matchingTokenIndex];
    if (!endCase || endCase.name !== "endcase") {
      throw new Error("THEME_RENDER_PRODUCT_BRANCH_UNCLOSED");
    }

    const branches = document.tokens.filter((candidate) =>
      candidate.kind === "LIQUID_TAG" &&
      (candidate.name === "when" || candidate.name === "else") &&
      nearestCaseAncestor(candidate) === token.index,
    );
    const productBranchIndex = branches.findIndex((candidate) =>
      candidate.name === "when" &&
      /(?:^|[\s,])(?:'product'|"product")(?:$|[\s,])/.test(candidate.markup ?? ""),
    );
    if (productBranchIndex < 0) {
      throw new Error("THEME_RENDER_PRODUCT_BRANCH_NOT_FOUND");
    }

    const productBranch = branches[productBranchIndex];
    const nextBranch = branches[productBranchIndex + 1];
    const body = source.slice(productBranch.end, nextBranch?.start ?? endCase.start);
    return source.slice(0, token.start) + body + source.slice(endCase.end);
  }

  return source;
}

function replaceIdentifierInStatement(
  source: string,
  identifier: string,
  replacement: string,
): string {
  const safeIdentifier =
    assertLiquidIdentifier(
      identifier,
      "THEME_RENDER_INVALID_PRODUCT_VARIABLE",
    );

  const escaped =
    escapeRegExp(
      safeIdentifier,
    );

  const pattern =
    new RegExp(
      `(^|[^A-Za-z0-9_-])${escaped}(?=$|[^A-Za-z0-9_-])`,
      "g",
    );

  return source.replace(
    pattern,

    (
      _match,
      prefix: string,
    ) => {
      return `${prefix}${replacement}`;
    },
  );
}

function renderStaticArguments(
  candidate:
    ThemeRendererCandidate,
): string[] {
  const productArgument =
    candidate
      .productBinding
      .argument
      ?.trim() ||
    null;

  return Object.entries(
    candidate.arguments,
  )
    .filter(
      ([name]) =>
        name !==
        productArgument,
    )
    .map(
      (
        [
          name,
          value,
        ],
      ) => {
        const safeName =
          assertLiquidIdentifier(
            name,
            "THEME_RENDER_INVALID_ARGUMENT_NAME",
          );

        return (
          `${safeName}: ` +
          serializeLiquidValue(
            value,
          )
        );
      },
    );
}

function parseStandardInvocation(
  tag: string,
): SnippetInvocation | null {
  const match =
    tag.match(
      /^\{%[-]?\s*(render|include)\s+(['"])([^'"]+)\2([\s\S]*?)[-]?%\}$/i,
    );

  if (
    !match
  ) {
    return null;
  }

  return {
    command:
      match[
        1
      ].toLowerCase() as
        SnippetCommand,

    snippet:
      normalizeSnippetName(
        match[3],
      ),

    source:
      `${match[
        1
      ].toLowerCase()} ${match[2]}${match[3]}${match[2]}${match[4]}`
        .trim(),
  };
}

function parseLiquidStatementInvocation(
  statement: string,
): SnippetInvocation | null {
  const match =
    statement.match(
      /^\s*(render|include)\s+(['"])([^'"]+)\2([\s\S]*)$/i,
    );

  if (
    !match
  ) {
    return null;
  }

  return {
    command:
      match[
        1
      ].toLowerCase() as
        SnippetCommand,

    snippet:
      normalizeSnippetName(
        match[3],
      ),

    source:
      `${match[
        1
      ].toLowerCase()} ${match[2]}${match[3]}${match[2]}${match[4]}`
        .trim(),
  };
}

function firstTopLevelCommaIndex(
  value: string,
): number {
  let quote:
    | "'"
    | '"'
    | null =
    null;

  let roundDepth =
    0;

  let squareDepth =
    0;

  for (
    let index = 0;
    index <
    value.length;
    index += 1
  ) {
    const char =
      value[index];

    if (
      quote
    ) {
      if (
        char ===
          quote &&
        value[
          index - 1
        ] !== "\\"
      ) {
        quote =
          null;
      }

      continue;
    }

    if (
      char === "'" ||
      char === '"'
    ) {
      quote =
        char;

      continue;
    }

    if (
      char === "("
    ) {
      roundDepth +=
        1;
    } else if (
      char === ")"
    ) {
      roundDepth =
        Math.max(
          0,
          roundDepth -
            1,
        );
    } else if (
      char === "["
    ) {
      squareDepth +=
        1;
    } else if (
      char === "]"
    ) {
      squareDepth =
        Math.max(
          0,
          squareDepth -
            1,
        );
    } else if (
      char === "," &&
      roundDepth ===
        0 &&
      squareDepth ===
        0
    ) {
      return index;
    }
  }

  return -1;
}

function buildSnippetExpression(
  candidate:
    ThemeRendererCandidate,

  invocation:
    SnippetInvocation,
): string {
  if (
    !candidate.snippet
  ) {
    throw new Error(
      "THEME_RENDER_SNIPPET_NAME_MISSING",
    );
  }

  const expectedSnippet =
    normalizeSnippetName(
      candidate.snippet,
    );

  if (
    invocation.snippet !==
    expectedSnippet
  ) {
    throw new Error(
      "THEME_RENDER_SNIPPET_MISMATCH",
    );
  }

  const staticArguments =
    renderStaticArguments(
      candidate,
    );

  const productArgument =
    candidate
      .productBinding
      .argument
      ?.trim() ||
    null;

  if (
    productArgument
  ) {
    const safeProductArgument =
      assertLiquidIdentifier(
        productArgument,
        "THEME_RENDER_INVALID_PRODUCT_ARGUMENT",
      );

    const args = [
      `${safeProductArgument}: ai_product`,
      ...staticArguments,
    ];

    return (
      `${invocation.command} ` +
      `'${expectedSnippet}', ` +
      args.join(
        ", ",
      )
    );
  }

  /**
   * Hỗ trợ:
   *
   * render 'card' with item
   * render 'card' for item
   */
  const commaIndex =
    firstTopLevelCommaIndex(
      invocation.source,
    );

  const head =
    (
      commaIndex >= 0
        ? invocation.source.slice(
            0,
            commaIndex,
          )
        : invocation.source
    ).trim();

  const sourceVariable =
    assertLiquidIdentifier(
      candidate
        .productBinding
        .sourceVariable,

      "THEME_RENDER_INVALID_PRODUCT_VARIABLE",
    );

  const withOrForPattern =
    new RegExp(
      `\\b(?:with|for)\\s+${escapeRegExp(
        sourceVariable,
      )}(?=$|\\s)`,
      "i",
    );

  if (
    !withOrForPattern.test(
      head,
    )
  ) {
    throw new Error(
      "THEME_RENDER_SNIPPET_PRODUCT_BINDING_UNRESOLVED",
    );
  }

  const patchedHead =
    replaceIdentifierInStatement(
      head,
      sourceVariable,
      "ai_product",
    );

  return staticArguments.length >
    0
    ? `${patchedHead}, ${staticArguments.join(
        ", ",
      )}`
    : patchedHead;
}

function replaceStandardSnippetTag(
  template: string,
  candidate:
    ThemeRendererCandidate,
): string | null {
  const target =
    normalizeSnippetName(
      candidate.snippet ||
        "",
    );

  const pattern =
    /\{%[-]?\s*(?:render|include)\b[\s\S]*?[-]?%\}/gi;

  let match:
    RegExpExecArray | null;

  while (
    (
      match =
        pattern.exec(
          template,
        )
    ) !== null
  ) {
    const tag =
      match[0];

    const invocation =
      parseStandardInvocation(
        tag,
      );

    if (
      !invocation ||
      invocation.snippet !==
        target
    ) {
      continue;
    }

    const expression =
      buildSnippetExpression(
        candidate,
        invocation,
      );

    const replacement =
      `{% ${expression} %}`;

    return (
      template.slice(
        0,
        match.index,
      ) +
      replacement +
      template.slice(
        match.index +
          tag.length,
      )
    );
  }

  return null;
}

const LIQUID_TAG_KEYWORD =
  /^(?:assign|capture|endcapture|case|when|endcase|if|elsif|else|endif|unless|endunless|for|endfor|tablerow|endtablerow|render|include|echo|liquid|cycle|increment|decrement|break|continue|comment|endcomment|raw|endraw)\b/i;

function replaceInLiquidBlockBody(
  body: string,
  candidate:
    ThemeRendererCandidate,
): string | null {
  const target =
    normalizeSnippetName(
      candidate.snippet ||
        "",
    );

  const lines =
    body.split(
      "\n",
    );

  for (
    let start = 0;
    start <
    lines.length;
    start += 1
  ) {
    const first =
      lines[start];

    if (
      !/^\s*(?:render|include)\b/i.test(
        first,
      )
    ) {
      continue;
    }

    let end =
      start + 1;

    while (
      end <
      lines.length
    ) {
      const trimmed =
        lines[
          end
        ].trimStart();

      if (
        trimmed &&
        LIQUID_TAG_KEYWORD.test(
          trimmed,
        )
      ) {
        break;
      }

      end += 1;
    }

    const statement =
      lines
        .slice(
          start,
          end,
        )
        .join(
          "\n",
        );

    const invocation =
      parseLiquidStatementInvocation(
        statement,
      );

    if (
      !invocation ||
      invocation.snippet !==
        target
    ) {
      continue;
    }

    const expression =
      buildSnippetExpression(
        candidate,
        invocation,
      );

    const indent =
      first.match(
        /^\s*/,
      )?.[0] ??
      "";

    return [
      ...lines.slice(
        0,
        start,
      ),

      `${indent}${expression}`,

      ...lines.slice(
        end,
      ),
    ].join(
      "\n",
    );
  }

  return null;
}

function replaceLiquidBlockSnippetStatement(
  template: string,
  candidate:
    ThemeRendererCandidate,
): string | null {
  const pattern =
    /\{%[-]?\s*liquid\b([\s\S]*?)[-]?%\}/gi;

  let match:
    RegExpExecArray | null;

  while (
    (
      match =
        pattern.exec(
          template,
        )
    ) !== null
  ) {
    const wholeBlock =
      match[0];

    const body =
      match[1] ??
      "";

    const patchedBody =
      replaceInLiquidBlockBody(
        body,
        candidate,
      );

    if (
      patchedBody ===
      null
    ) {
      continue;
    }

    const normalizedBody =
      patchedBody.endsWith(
        "\n",
      )
        ? patchedBody
        : `${patchedBody}\n`;

    const replacement =
      `{% liquid${normalizedBody}%}`;

    return (
      template.slice(
        0,
        match.index,
      ) +
      replacement +
      template.slice(
        match.index +
          wholeBlock.length,
      )
    );
  }

  return null;
}

function renderSnippetItem(
  candidate:
    ThemeRendererCandidate,
): string {
  const sourceVariable =
    candidate.productBinding.sourceVariable;
  const productTemplate =
    extractKnownProductBranch(
      candidate.itemTemplate,
      sourceVariable,
    );
  const productCandidate = {
    ...candidate,
    itemTemplate: productTemplate,
  };

  const standard =
    replaceStandardSnippetTag(
      productTemplate,

      productCandidate,
    );

  if (
    standard !==
    null
  ) {
    return rewriteProductExpressions(
      standard,
      sourceVariable,
    );
  }

  const liquidBlock =
    replaceLiquidBlockSnippetStatement(
      productTemplate,

      productCandidate,
    );

  if (
    liquidBlock !==
    null
  ) {
    return rewriteProductExpressions(
      liquidBlock,
      sourceVariable,
    );
  }

  throw new Error(
    "THEME_RENDER_SOURCE_CALL_NOT_FOUND",
  );
}

function renderInlineItem(
  candidate:
    ThemeRendererCandidate,
): string {
  const sourceVariable =
    candidate.productBinding.sourceVariable;
  const productTemplate =
    extractKnownProductBranch(
      candidate.itemTemplate,
      sourceVariable,
    );

  return rewriteProductExpressions(
    productTemplate,
    sourceVariable,
  );
}

function renderCandidateItem(
  candidate:
    ThemeRendererCandidate,
): string {
  return candidate.type ===
    "SNIPPET"
    ? renderSnippetItem(
        candidate,
      )
    : renderInlineItem(
        candidate,
      );
}

function runtimeSupported(
  candidate:
    ThemeRendererCandidate,
): boolean {
  return (
    candidate.runtime.mode ===
      "STATIC" ||
    candidate.runtime.mode ===
      "CUSTOM_ELEMENT" ||
    candidate.runtime.mode ===
      "STANDARD_EVENT"
  );
}

/**
 * Candidate được phép chạy qua App Proxy Liquid hiện tại.
 *
 * THEME_CONTEXT_REQUIRED tuyệt đối không được lọt vào đây.
 */
function candidateEligible(
  candidate:
    ThemeRendererCandidate,
): boolean {
  return (
    candidate.status ===
      "ELIGIBLE" &&
    candidate
      .renderStrategy ===
      "APP_PROXY_LIQUID" &&
    candidate.mount !=
      null &&
    candidate
      .usesAllProducts ===
      false &&
    runtimeSupported(
      candidate,
    )
  );
}

export function getThemeResultRendererCandidates(
  map: ThemeMapV4,
): ThemeRendererCandidate[] {
  if (
    map.status !==
    "VERIFIED"
  ) {
    return [];
  }

  return map
    .rendererCandidates
    .filter(
      candidateEligible,
    )
    .slice()
    .sort(
      (
        left,
        right,
      ) => {
        return (
          right.score -
            left.score ||
          left.id.localeCompare(
            right.id,
          )
        );
      },
    );
}

function selectCandidate(
  map: ThemeMapV4,
  candidateId?: string,
): ThemeRendererCandidate {
  if (
    map.status !==
    "VERIFIED"
  ) {
    throw new Error(
      `THEME_MAP_UNSUPPORTED:${map.unsupportedReason}`,
    );
  }

  if (
    candidateId
  ) {
    const exact =
      map
        .rendererCandidates
        .find(
          (
            candidate,
          ) =>
            candidate.id ===
            candidateId,
        );

    if (
      !exact ||
      !candidateEligible(
        exact,
      )
    ) {
      throw new Error(
        "THEME_RENDER_CANDIDATE_NOT_ELIGIBLE",
      );
    }

    return exact;
  }

  const first =
    getThemeResultRendererCandidates(
      map,
    )[0];

  if (
    !first
  ) {
    throw new Error(
      "THEME_RENDER_CANDIDATE_NOT_FOUND",
    );
  }

  return first;
}

function normalizeProducts(
  products:
    ThemeRenderProduct[],
): ThemeRenderProduct[] {
  const seenHandles =
    new Set<string>();

  const result:
    ThemeRenderProduct[] =
      [];

  for (
    const product
    of products
  ) {
    const handle =
      String(
        product.handle ||
          "",
      ).trim();

    if (
      !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(
        handle,
      )
    ) {
      throw new Error(
        "THEME_RENDER_INVALID_PRODUCT_HANDLE",
      );
    }

    if (
      seenHandles.has(
        handle,
      )
    ) {
      continue;
    }

    seenHandles.add(
      handle,
    );

    result.push({
      productId:
        product.productId,

      handle,
    });
  }

  return result;
}

function renderPageLimit(
  map: ThemeMapV4,
): number {
  const configured =
    Number.isFinite(
      map.pageSize,
    )
      ? Math.floor(
          map.pageSize,
        )
      : ALL_PRODUCTS_PAGE_LIMIT;

  return Math.max(
    1,
    Math.min(
      ALL_PRODUCTS_PAGE_LIMIT,
      configured,
    ),
  );
}

function buildLiquid(
  candidate:
    ThemeRendererCandidate,

  products:
    ThemeRenderProduct[],
): string {
  /**
   * Defense-in-depth:
   *
   * App Proxy Liquid tuyệt đối không được replay
   * Theme Block candidate cần section/block context thật.
   *
   * selectCandidate() và candidateEligible() đã chặn trước,
   * nhưng giữ guard tại điểm build Liquid để tránh future caller
   * vô tình bypass contract.
   */
  if (
    candidate
      .renderStrategy !==
    "APP_PROXY_LIQUID"
  ) {
    throw new Error(
      "THEME_RENDER_STRATEGY_NOT_SUPPORTED",
    );
  }

  const item =
    renderCandidateItem(
      candidate,
    );

  return products
    .map(
      (
        product,
      ) => {
        return [
          `{% assign ai_product = all_products['${product.handle}'] %}`,

          "{% if ai_product != blank %}",

          item,

          "{% endif %}",
        ].join(
          "\n",
        );
      },
    )
    .join(
      "\n",
    );
}

export function buildThemeResultLiquid(
  args: {
    map: ThemeMapV4;

    products:
      ThemeRenderProduct[];

    candidateId?: string;
  },
): ThemeResultRenderPlan {
  if (
    args.map.status !==
    "VERIFIED"
  ) {
    throw new Error(
      `THEME_MAP_UNSUPPORTED:${args.map.unsupportedReason}`,
    );
  }

  const products =
    normalizeProducts(
      args.products,
    );

  const pageLimit =
    renderPageLimit(
      args.map,
    );

  if (
    products.length >
    pageLimit
  ) {
    throw new Error(
      "THEME_RENDER_PAGE_SIZE_EXCEEDED",
    );
  }

  if (
    args.candidateId
  ) {
    const candidate =
      selectCandidate(
        args.map,
        args.candidateId,
      );

    const liquid =
      buildLiquid(
        candidate,
        products,
      );

    return {
      liquid,

      candidateId:
        candidate.id,

      candidate,

      mount:
        candidate.mount!,

      handles:
        products.map(
          (
            product,
          ) =>
            product.handle,
        ),

      productCount:
        products.length,
    };
  }

  let lastError:
    unknown =
    null;

  for (
    const candidate
    of getThemeResultRendererCandidates(
      args.map,
    )
  ) {
    try {
      const liquid =
        buildLiquid(
          candidate,
          products,
        );

      return {
        liquid,

        candidateId:
          candidate.id,

        candidate,

        mount:
          candidate.mount!,

        handles:
          products.map(
            (
              product,
            ) =>
              product.handle,
          ),

        productCount:
          products.length,
      };
    } catch (
      error
    ) {
      lastError =
        error;
    }
  }

  if (
    lastError instanceof
    Error
  ) {
    throw lastError;
  }

  throw new Error(
    "THEME_RENDER_CANDIDATE_NOT_FOUND",
  );
}

/** Rebind only parsed Liquid expressions, never surrounding HTML/text. */
function rewriteProductExpressions(
  source: string,
  sourceVariable: string,
): string {
  const document = parseLiquidDocument(source);
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  const objectTypePattern = new RegExp(
    `\\b${escapeRegExp(sourceVariable)}\\s*\\.\\s*object_type\\b`,
  );

  for (const token of document.tokens) {
    if (token.kind !== "LIQUID_TAG" && token.kind !== "LIQUID_OUTPUT") continue;
    if (objectTypePattern.test(token.raw)) {
      throw new Error("THEME_RENDER_SEARCH_RESULT_METADATA_UNRESOLVED");
    }
    const replacement = replaceIdentifierInStatement(
      token.raw,
      sourceVariable,
      "ai_product",
    );
    if (replacement !== token.raw) {
      edits.push({ start: token.start, end: token.end, replacement });
    }
  }

  return edits
    .sort((left, right) => right.start - left.start)
    .reduce(
      (result, edit) =>
        result.slice(0, edit.start) + edit.replacement + result.slice(edit.end),
      source,
    );
}
