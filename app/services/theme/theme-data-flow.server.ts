import type {
  HtmlFrame,
  LiquidFrame,
  LiquidToken,
  ParsedLiquidDocument,
} from "./liquid-ast.server";

export type DataFlowOrigin =
  | {
      kind: "SEARCH_RESULTS_COLLECTION";
      productOnly: boolean;
    }
  | {
      kind: "SEARCH_RESULT_ITEM";
      loopTokenIndex: number;
      loopVariable: string;
      productOnly: boolean;
    };

export interface VariableBinding {
  variable: string;

  origin: DataFlowOrigin;

  createdAtTokenIndex: number;

  /**
   * Nếu binding được tạo trong loop,
   * nó chỉ hợp lệ khi token hiện tại vẫn nằm trong loop này.
   */
  scopeTokenIndex?: number;
}

export interface RenderArgumentFlow {
  name: string;

  expression: string;

  /**
   * Argument nhận trực tiếp Search Result Product object.
   */
  receivesSearchResult: boolean;

  sourceVariable?: string;
}

export interface ProductBindingFlow {
  sourceVariable: string;

  argument: string;

  loopVariable: string;

  loopTokenIndex: number;
}

export interface DiscoveredRendererCall {
  tokenIndex: number;

  sourceFile: string;

  invocation:
    | "RENDER"
    | "INCLUDE";

  raw: string;

  /**
   * Có thể null nếu snippet name là expression động.
   */
  snippetName: string | null;

  snippetExpression: string;

  arguments: RenderArgumentFlow[];

  productBinding?: ProductBindingFlow;

  /**
   * TRUE chỉ khi compiler chứng minh được
   * invocation này nằm trong product branch,
   * hoặc source collection đã được lọc product-only.
   */
  productBranchProven: boolean;

  branchEvidence: string[];

  liquidAncestors: LiquidFrame[];

  htmlAncestors: HtmlFrame[];
}

export interface InlineProductUsage {
  tokenIndex: number;

  sourceFile: string;

  expression: string;

  sourceVariable: string;

  loopVariable: string;

  loopTokenIndex: number;

  productBranchProven: boolean;

  branchEvidence: string[];

  htmlAncestors: HtmlFrame[];

  liquidAncestors: LiquidFrame[];
}

export interface SearchDataFlowAnalysis {
  sourceFile: string;

  /**
   * Tất cả render/include có liên quan trực tiếp
   * tới object bắt nguồn từ search.results.
   */
  rendererCalls: DiscoveredRendererCall[];

  /**
   * Liquid output dùng trực tiếp search-result object:
   *
   * {{ item.title }}
   * {{ item.url }}
   *
   * Dùng cho INLINE renderer ở bước sau.
   */
  inlineProductUsages: InlineProductUsage[];

  /**
   * Dùng cho debug/compiler tests.
   */
  bindings: VariableBinding[];
}

type BranchState =
  | {
      kind: "IF";
      condition: string;
      mode:
        | "IF"
        | "ELSIF"
        | "ELSE";
    }
  | {
      kind: "UNLESS";
      condition: string;
      mode:
        | "UNLESS"
        | "ELSE";
    }
  | {
      kind: "CASE";
      expression: string;
      whenExpression: string | null;
    };

function stripOuterParentheses(
  input: string,
): string {
  let value = input.trim();

  while (
    value.startsWith("(") &&
    value.endsWith(")")
  ) {
    value = value
      .slice(1, -1)
      .trim();
  }

  return value;
}

function normalizeExpression(
  input: string,
): string {
  return stripOuterParentheses(
    input.trim(),
  );
}

function expressionRootVariable(
  expression: string,
): string | null {
  const normalized =
    normalizeExpression(expression);

  const match = normalized.match(
    /^([A-Za-z_][A-Za-z0-9_-]*)/,
  );

  return match?.[1] ?? null;
}

function isDirectVariableExpression(
  expression: string,
): string | null {
  const normalized =
    normalizeExpression(expression);

  const match = normalized.match(
    /^([A-Za-z_][A-Za-z0-9_-]*)$/,
  );

  return match?.[1] ?? null;
}

function isDirectSearchResultsExpression(
  expression: string,
): boolean {
  const normalized =
    normalizeExpression(expression);

  return (
    normalized ===
      "search.results" ||
    normalized.startsWith(
      "search.results |",
    )
  );
}

/**
 * Nhận diện dạng:
 *
 * search.results
 *   | where: 'object_type', 'product'
 *
 * Nếu filter không rõ ràng thì productOnly = false.
 */
function searchResultsProductOnly(
  expression: string,
): boolean {
  if (
    !isDirectSearchResultsExpression(
      expression,
    )
  ) {
    return false;
  }

  const value =
    expression.toLowerCase();

  const whereObjectType =
    /where\s*:\s*['"]object_type['"]\s*,\s*['"]product['"]/i;

  return whereObjectType.test(value);
}

function parseAssign(
  markup: string,
): {
  variable: string;
  expression: string;
} | null {
  const match = markup.match(
    /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+)$/s,
  );

  if (!match) {
    return null;
  }

  return {
    variable: match[1],
    expression:
      match[2].trim(),
  };
}

function parseFor(
  markup: string,
): {
  variable: string;
  collection: string;
} | null {
  const match = markup.match(
    /^([A-Za-z_][A-Za-z0-9_-]*)\s+in\s+(.+)$/s,
  );

  if (!match) {
    return null;
  }

  let collection =
    match[2].trim();

  /**
   * Bỏ các option thuộc for tag:
   *
   * limit:
   * offset:
   * reversed
   *
   * Chỉ làm trên top-level expression đơn giản.
   */
  const optionMatch =
    collection.search(
      /\s+(?:limit\s*:|offset\s*:|reversed\b)/i,
    );

  if (
    optionMatch >= 0
  ) {
    collection =
      collection
        .slice(
          0,
          optionMatch,
        )
        .trim();
  }

  return {
    variable:
      match[1],

    collection,
  };
}

function activeAncestorIndexes(
  token: LiquidToken,
): Set<number> {
  return new Set(
    token.liquidAncestors.map(
      (frame) =>
        frame.tokenIndex,
    ),
  );
}

function bindingIsActive(
  binding: VariableBinding,
  token: LiquidToken,
): boolean {
  if (
    binding.scopeTokenIndex ==
    null
  ) {
    return true;
  }

  return activeAncestorIndexes(
    token,
  ).has(
    binding.scopeTokenIndex,
  );
}

function resolveVariableBinding(
  variable: string,
  token: LiquidToken,
  bindings: VariableBinding[],
): VariableBinding | null {
  for (
    let i =
      bindings.length - 1;
    i >= 0;
    i--
  ) {
    const binding =
      bindings[i];

    if (
      binding.variable ===
        variable &&
      binding.createdAtTokenIndex <=
        token.index &&
      bindingIsActive(
        binding,
        token,
      )
    ) {
      return binding;
    }
  }

  return null;
}

function resolveCollectionOrigin(
  expression: string,
  token: LiquidToken,
  bindings: VariableBinding[],
): Extract<
  DataFlowOrigin,
  {
    kind:
      "SEARCH_RESULTS_COLLECTION";
  }
> | null {
  if (
    isDirectSearchResultsExpression(
      expression,
    )
  ) {
    return {
      kind:
        "SEARCH_RESULTS_COLLECTION",

      productOnly:
        searchResultsProductOnly(
          expression,
        ),
    };
  }

  const variable =
    isDirectVariableExpression(
      expression,
    );

  if (!variable) {
    return null;
  }

  const binding =
    resolveVariableBinding(
      variable,
      token,
      bindings,
    );

  if (
    binding?.origin.kind !==
    "SEARCH_RESULTS_COLLECTION"
  ) {
    return null;
  }

  return binding.origin;
}

function resolveItemOrigin(
  variable: string,
  token: LiquidToken,
  bindings: VariableBinding[],
): Extract<
  DataFlowOrigin,
  {
    kind:
      "SEARCH_RESULT_ITEM";
  }
> | null {
  const binding =
    resolveVariableBinding(
      variable,
      token,
      bindings,
    );

  if (
    binding?.origin.kind !==
    "SEARCH_RESULT_ITEM"
  ) {
    return null;
  }

  return binding.origin;
}

function nearestSearchLoopScope(
  token: LiquidToken,
  bindings: VariableBinding[],
): number | undefined {
  for (
    let i =
      token.liquidAncestors.length -
      1;
    i >= 0;
    i--
  ) {
    const frame =
      token.liquidAncestors[i];

    if (
      frame.name !== "for"
    ) {
      continue;
    }

    const hasSearchItem =
      bindings.some(
        (binding) =>
          binding.scopeTokenIndex ===
            frame.tokenIndex &&
          binding.origin.kind ===
            "SEARCH_RESULT_ITEM",
      );

    if (hasSearchItem) {
      return frame.tokenIndex;
    }
  }

  return undefined;
}

function sameItemOrigin(
  left: Extract<
    DataFlowOrigin,
    {
      kind:
        "SEARCH_RESULT_ITEM";
    }
  >,
  right: Extract<
    DataFlowOrigin,
    {
      kind:
        "SEARCH_RESULT_ITEM";
    }
  >,
): boolean {
  return (
    left.loopTokenIndex ===
    right.loopTokenIndex
  );
}

function aliasesForOrigin(
  origin: Extract<
    DataFlowOrigin,
    {
      kind:
        "SEARCH_RESULT_ITEM";
    }
  >,
  token: LiquidToken,
  bindings: VariableBinding[],
): string[] {
  const names =
    new Set<string>();

  names.add(
    origin.loopVariable,
  );

  for (
    const binding
    of bindings
  ) {
    if (
      !bindingIsActive(
        binding,
        token,
      ) ||
      binding.origin.kind !==
        "SEARCH_RESULT_ITEM"
    ) {
      continue;
    }

    if (
      sameItemOrigin(
        binding.origin,
        origin,
      )
    ) {
      names.add(
        binding.variable,
      );
    }
  }

  return [...names];
}

function escapeRegExp(
  value: string,
): string {
  return value.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
}

function normalizeQuotedLiteral(
  value: string,
): string {
  const trimmed =
    value.trim();

  if (
    (
      trimmed.startsWith(
        "'",
      ) &&
      trimmed.endsWith("'")
    ) ||
    (
      trimmed.startsWith(
        '"',
      ) &&
      trimmed.endsWith('"')
    )
  ) {
    return trimmed
      .slice(1, -1)
      .trim();
  }

  return trimmed;
}

/**
 * Chỉ chứng minh các condition rõ ràng.
 *
 * Không suy luận những condition mơ hồ.
 */
function conditionProvesProduct(
  condition: string,
  aliases: string[],
): boolean {
  const value =
    condition.trim();

  /**
   * OR không đủ để chứng minh:
   *
   * item.object_type == 'product'
   * OR something_else
   *
   * vì branch có thể chạy do something_else.
   */
  if (
    /\bor\b/i.test(value)
  ) {
    return false;
  }

  for (
    const alias
    of aliases
  ) {
    const name =
      escapeRegExp(alias);

    const equality =
      new RegExp(
        `\\b${name}\\.object_type\\s*==\\s*(['"])product\\1`,
        "i",
      );

    if (
      equality.test(value)
    ) {
      return true;
    }
  }

  return false;
}

function unlessProvesProduct(
  condition: string,
  aliases: string[],
): boolean {
  const value =
    condition.trim();

  if (
    /\bor\b/i.test(value)
  ) {
    return false;
  }

  for (
    const alias
    of aliases
  ) {
    const name =
      escapeRegExp(alias);

    /**
     * unless item.object_type != 'product'
     *
     * body chạy khi condition FALSE
     * → object_type == product.
     */
    const inequality =
      new RegExp(
        `\\b${name}\\.object_type\\s*!=\\s*(['"])product\\1`,
        "i",
      );

    if (
      inequality.test(value)
    ) {
      return true;
    }
  }

  return false;
}

function caseBranchProvesProduct(
  expression: string,
  whenExpression: string | null,
  aliases: string[],
): boolean {
  if (!whenExpression) {
    return false;
  }

  const normalizedCase =
    expression
      .trim()
      .replace(/\s+/g, "");

  const caseMatches =
    aliases.some(
      (alias) =>
        normalizedCase ===
        `${alias}.object_type`,
    );

  if (!caseMatches) {
    return false;
  }

  /**
   * Không chấp nhận:
   *
   * when 'product', 'article'
   *
   * vì branch không còn product-only.
   */
  const values =
    whenExpression
      .split(",")
      .map(
        normalizeQuotedLiteral,
      )
      .filter(Boolean);

  return (
    values.length === 1 &&
    values[0].toLowerCase() ===
      "product"
  );
}

function activeBranchEvidence(
  token: LiquidToken,
  origin: Extract<
    DataFlowOrigin,
    {
      kind:
        "SEARCH_RESULT_ITEM";
    }
  >,
  bindings: VariableBinding[],
  branchStates: Map<
    number,
    BranchState
  >,
): {
  proven: boolean;
  evidence: string[];
} {
  if (
    origin.productOnly
  ) {
    return {
      proven: true,

      evidence: [
        "SEARCH_RESULTS_COLLECTION_FILTERED_TO_PRODUCT",
      ],
    };
  }

  const aliases =
    aliasesForOrigin(
      origin,
      token,
      bindings,
    );

  const evidence:
    string[] = [];

  for (
    const frame
    of token.liquidAncestors
  ) {
    const state =
      branchStates.get(
        frame.tokenIndex,
      );

    if (!state) {
      continue;
    }

    if (
      state.kind === "IF" &&
      (
        state.mode === "IF" ||
        state.mode ===
          "ELSIF"
      ) &&
      conditionProvesProduct(
        state.condition,
        aliases,
      )
    ) {
      evidence.push(
        `${state.mode}:${state.condition}`,
      );
    }

    if (
      state.kind ===
        "UNLESS" &&
      state.mode ===
        "UNLESS" &&
      unlessProvesProduct(
        state.condition,
        aliases,
      )
    ) {
      evidence.push(
        `UNLESS:${state.condition}`,
      );
    }

    if (
      state.kind ===
        "CASE" &&
      caseBranchProvesProduct(
        state.expression,
        state.whenExpression,
        aliases,
      )
    ) {
      evidence.push(
        `CASE:${state.expression} WHEN ${state.whenExpression}`,
      );
    }
  }

  return {
    proven:
      evidence.length > 0,

    evidence,
  };
}

function splitTopLevelComma(
  input: string,
): string[] {
  const parts: string[] = [];

  let quote:
    "'" | '"' | null = null;

  let depth = 0;
  let start = 0;

  for (
    let i = 0;
    i < input.length;
    i++
  ) {
    const char =
      input[i];

    if (quote) {
      if (
        char === "\\" &&
        i + 1 <
          input.length
      ) {
        i++;
        continue;
      }

      if (
        char === quote
      ) {
        quote = null;
      }

      continue;
    }

    if (
      char === "'" ||
      char === '"'
    ) {
      quote = char;
      continue;
    }

    if (
      char === "(" ||
      char === "[" ||
      char === "{"
    ) {
      depth++;
      continue;
    }

    if (
      char === ")" ||
      char === "]" ||
      char === "}"
    ) {
      depth =
        Math.max(
          0,
          depth - 1,
        );

      continue;
    }

    if (
      char === "," &&
      depth === 0
    ) {
      parts.push(
        input
          .slice(
            start,
            i,
          )
          .trim(),
      );

      start = i + 1;
    }
  }

  parts.push(
    input
      .slice(start)
      .trim(),
  );

  return parts.filter(
    Boolean,
  );
}

function parseSnippetHead(
  markup: string,
): {
  snippetName: string | null;
  snippetExpression: string;
  rest: string;
} {
  const value =
    markup.trim();

  const quoted =
    value.match(
      /^(['"])(.*?)\1([\s\S]*)$/,
    );

  if (quoted) {
    return {
      snippetName:
        quoted[2],

      snippetExpression:
        quoted[0].slice(
          0,
          quoted[0].length -
            quoted[3].length,
        ),

      rest:
        quoted[3]
          .trim()
          .replace(
            /^,/,
            "",
          )
          .trim(),
    };
  }

  /**
   * Dynamic snippet:
   *
   * {% render renderer_name, product: item %}
   *
   * Ta vẫn ghi nhận data-flow nhưng snippetName = null.
   * Candidate compiler sau đó có thể reject vì dynamic renderer.
   */
  const comma =
    value.indexOf(",");

  const first =
    comma >= 0
      ? value.slice(
          0,
          comma,
        )
      : value;

  const firstSpace =
    first.search(/\s/);

  const expression =
    (
      firstSpace >= 0
        ? first.slice(
            0,
            firstSpace,
          )
        : first
    ).trim();

  return {
    snippetName: null,

    snippetExpression:
      expression,

    rest:
      value
        .slice(
          expression.length,
        )
        .trim()
        .replace(
          /^,/,
          "",
        )
        .trim(),
  };
}

function parseNamedArgument(
  part: string,
): {
  name: string;
  expression: string;
} | null {
  const match =
    part.match(
      /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*([\s\S]+)$/,
    );

  if (!match) {
    return null;
  }

  return {
    name: match[1],

    expression:
      match[2].trim(),
  };
}

/**
 * Shopify Theme Blocks được gọi bằng content_for và có thể truyền
 * resource context bằng dotted argument, ví dụ:
 *
 * {% content_for 'block',
 *   type: '_product-card',
 *   id: 'product-card',
 *   closest.product: item
 * %}
 *
 * Dotted argument không phải render/include argument thông thường nên
 * parseNamedArgument() phía trên cố ý vẫn giữ contract cũ.
 */
function parseContentForNamedArgument(
  part: string,
): {
  name: string;
  expression: string;
} | null {
  const match =
    part.match(
      /^([A-Za-z_][A-Za-z0-9_.-]*)\s*:\s*([\s\S]+)$/,
    );

  if (!match) {
    return null;
  }

  return {
    name:
      match[1],

    expression:
      match[2].trim(),
  };
}

function parseContentForArguments(
  markup: string,
): {
  mode:
    | "block"
    | "blocks"
    | null;
  arguments: Array<{
    name: string;
    expression: string;
  }>;
} {
  const parts =
    splitTopLevelComma(
      markup,
    );

  const head =
    parts.shift() ??
    "";

  const headMatch =
    head.match(
      /^(['"])(block|blocks)\1$/i,
    );

  const mode =
    headMatch
      ? headMatch[2]
          .toLowerCase() as
          | "block"
          | "blocks"
      : null;

  const args: Array<{
    name: string;
    expression: string;
  }> = [];

  for (
    const part
    of parts
  ) {
    const named =
      parseContentForNamedArgument(
        part,
      );

    if (named) {
      args.push(
        named,
      );
    }
  }

  return {
    mode,
    arguments:
      args,
  };
}

function parseRenderArguments(
  markup: string,
): {
  snippetName: string | null;
  snippetExpression: string;
  arguments: Array<{
    name: string;
    expression: string;
  }>;
} {
  const head =
    parseSnippetHead(
      markup,
    );

  const args: Array<{
    name: string;
    expression: string;
  }> = [];

  if (!head.rest) {
    return {
      snippetName:
        head.snippetName,

      snippetExpression:
        head.snippetExpression,

      arguments: args,
    };
  }

  /**
   * render 'x' with item as product
   */
  const withMatch =
    head.rest.match(
      /^(?:with)\s+([A-Za-z_][A-Za-z0-9_-]*)\s+as\s+([A-Za-z_][A-Za-z0-9_-]*)(?:\s*,\s*([\s\S]+))?$/i,
    );

  if (withMatch) {
    args.push({
      name:
        withMatch[2],

      expression:
        withMatch[1],
    });

    if (withMatch[3]) {
      for (
        const part
        of splitTopLevelComma(
          withMatch[3],
        )
      ) {
        const named =
          parseNamedArgument(
            part,
          );

        if (named) {
          args.push(
            named,
          );
        }
      }
    }

    return {
      snippetName:
        head.snippetName,

      snippetExpression:
        head.snippetExpression,

      arguments: args,
    };
  }

  /**
   * render 'x' for products as product
   *
   * Không coi đây là ProductBinding trực tiếp,
   * vì expression là collection chứ không phải item.
   *
   * Candidate compiler bước sau sẽ xử lý/reject riêng.
   */
  const forMatch =
    head.rest.match(
      /^(?:for)\s+([A-Za-z_][A-Za-z0-9_-]*)\s+as\s+([A-Za-z_][A-Za-z0-9_-]*)(?:\s*,\s*([\s\S]+))?$/i,
    );

  if (forMatch) {
    args.push({
      name:
        `__for__${forMatch[2]}`,

      expression:
        forMatch[1],
    });

    if (forMatch[3]) {
      for (
        const part
        of splitTopLevelComma(
          forMatch[3],
        )
      ) {
        const named =
          parseNamedArgument(
            part,
          );

        if (named) {
          args.push(
            named,
          );
        }
      }
    }

    return {
      snippetName:
        head.snippetName,

      snippetExpression:
        head.snippetExpression,

      arguments: args,
    };
  }

  for (
    const part
    of splitTopLevelComma(
      head.rest,
    )
  ) {
    const named =
      parseNamedArgument(
        part,
      );

    if (named) {
      args.push(named);
    }
  }

  return {
    snippetName:
      head.snippetName,

    snippetExpression:
      head.snippetExpression,

    arguments: args,
  };
}

function updateBranchState(
  token: LiquidToken,
  branchStates: Map<
    number,
    BranchState
  >,
) {
  if (
    token.kind !==
    "LIQUID_TAG"
  ) {
    return;
  }

  const name =
    token.name ?? "";

  const markup =
    token.markup ?? "";

  if (
    name === "if"
  ) {
    branchStates.set(
      token.index,
      {
        kind: "IF",
        condition: markup,
        mode: "IF",
      },
    );

    return;
  }

  if (
    name === "unless"
  ) {
    branchStates.set(
      token.index,
      {
        kind:
          "UNLESS",
        condition:
          markup,
        mode:
          "UNLESS",
      },
    );

    return;
  }

  if (
    name === "case"
  ) {
    branchStates.set(
      token.index,
      {
        kind: "CASE",
        expression:
          markup,
        whenExpression:
          null,
      },
    );

    return;
  }

  if (
    name === "elsif"
  ) {
    const parent =
      [...token.liquidAncestors]
        .reverse()
        .find(
          (frame) =>
            frame.name ===
            "if",
        );

    if (!parent) {
      return;
    }

    branchStates.set(
      parent.tokenIndex,
      {
        kind: "IF",
        condition: markup,
        mode: "ELSIF",
      },
    );

    return;
  }

  if (
    name === "else"
  ) {
    const parent =
      [...token.liquidAncestors]
        .reverse()
        .find(
          (frame) =>
            frame.name ===
              "if" ||
            frame.name ===
              "unless",
        );

    if (!parent) {
      return;
    }

    const current =
      branchStates.get(
        parent.tokenIndex,
      );

    if (
      current?.kind ===
      "IF"
    ) {
      branchStates.set(
        parent.tokenIndex,
        {
          ...current,
          mode: "ELSE",
        },
      );
    }

    if (
      current?.kind ===
      "UNLESS"
    ) {
      branchStates.set(
        parent.tokenIndex,
        {
          ...current,
          mode: "ELSE",
        },
      );
    }

    return;
  }

  if (
    name === "when"
  ) {
    const parent =
      [...token.liquidAncestors]
        .reverse()
        .find(
          (frame) =>
            frame.name ===
            "case",
        );

    if (!parent) {
      return;
    }

    const current =
      branchStates.get(
        parent.tokenIndex,
      );

    if (
      current?.kind !==
      "CASE"
    ) {
      return;
    }

    branchStates.set(
      parent.tokenIndex,
      {
        ...current,

        whenExpression:
          markup,
      },
    );
  }
}

function cleanupBranchStates(
  token: LiquidToken,
  branchStates: Map<
    number,
    BranchState
  >,
) {
  const active =
    activeAncestorIndexes(
      token,
    );

  /**
   * Opening block hiện tại chưa xuất hiện trong
   * liquidAncestors của chính nó.
   */
  if (
    token.kind ===
      "LIQUID_TAG" &&
    (
      token.name === "if" ||
      token.name ===
        "unless" ||
      token.name === "case"
    )
  ) {
    active.add(
      token.index,
    );
  }

  for (
    const index
    of branchStates.keys()
  ) {
    if (
      !active.has(index)
    ) {
      branchStates.delete(
        index,
      );
    }
  }
}

function rootExpressionBinding(
  expression: string,
  token: LiquidToken,
  bindings: VariableBinding[],
): {
  variable: string;
  origin: Extract<
    DataFlowOrigin,
    {
      kind:
        "SEARCH_RESULT_ITEM";
    }
  >;
} | null {
  const variable =
    expressionRootVariable(
      expression,
    );

  if (!variable) {
    return null;
  }

  const origin =
    resolveItemOrigin(
      variable,
      token,
      bindings,
    );

  if (!origin) {
    return null;
  }

  return {
    variable,
    origin,
  };
}

export function analyzeSearchResultDataFlow(
  document: ParsedLiquidDocument,
  options: {
    sourceFile: string;
  },
): SearchDataFlowAnalysis {
  const bindings:
    VariableBinding[] = [];

  const rendererCalls:
    DiscoveredRendererCall[] = [];

  const inlineProductUsages:
    InlineProductUsage[] = [];

  const branchStates =
    new Map<
      number,
      BranchState
    >();

  for (
    const token
    of document.tokens
  ) {
    cleanupBranchStates(
      token,
      branchStates,
    );

    /**
     * Update branch state trước khi xử lý các token
     * nằm sau if/when/elsif.
     */
    updateBranchState(
      token,
      branchStates,
    );

    if (
      token.kind ===
        "LIQUID_TAG" &&
      token.name === "assign"
    ) {
      const assign =
        parseAssign(
          token.markup ?? "",
        );

      if (assign) {
        /**
         * assign foo = search.results
         */
        if (
          isDirectSearchResultsExpression(
            assign.expression,
          )
        ) {
          bindings.push({
            variable:
              assign.variable,

            origin: {
              kind:
                "SEARCH_RESULTS_COLLECTION",

              productOnly:
                searchResultsProductOnly(
                  assign.expression,
                ),
            },

            createdAtTokenIndex:
              token.index,

            scopeTokenIndex:
              nearestSearchLoopScope(
                token,
                bindings,
              ),
          });

          continue;
        }

        /**
         * assign alias = existing_collection
         */
        const directVariable =
          isDirectVariableExpression(
            assign.expression,
          );

        if (directVariable) {
          const existing =
            resolveVariableBinding(
              directVariable,
              token,
              bindings,
            );

          if (existing) {
            bindings.push({
              variable:
                assign.variable,

              origin:
                existing.origin,

              createdAtTokenIndex:
                token.index,

              scopeTokenIndex:
                nearestSearchLoopScope(
                  token,
                  bindings,
                ),
            });

            continue;
          }
        }
      }
    }

    /**
     * for item in search.results
     *
     * hoặc:
     *
     * assign results = search.results
     * for item in results
     */
    if (
      token.kind ===
        "LIQUID_TAG" &&
      token.name === "for"
    ) {
      const loop =
        parseFor(
          token.markup ?? "",
        );

      if (loop) {
        const collection =
          resolveCollectionOrigin(
            loop.collection,
            token,
            bindings,
          );

        if (collection) {
          bindings.push({
            variable:
              loop.variable,

            origin: {
              kind:
                "SEARCH_RESULT_ITEM",

              loopTokenIndex:
                token.index,

              loopVariable:
                loop.variable,

              productOnly:
                collection.productOnly,
            },

            createdAtTokenIndex:
              token.index,

            scopeTokenIndex:
              token.index,
          });
        }
      }

      continue;
    }

    /**
     * Shopify Theme Blocks / nested Theme Blocks.
     *
     * Ta không đoán block filename hay block type ở bước data-flow.
     * Chỉ ghi nhận khi chính content_for truyền object bắt nguồn từ
     * search.results vào product resource context đã biết:
     *
     * - closest.product
     * - context.product
     *
     * Candidate compiler sau đó sẽ replay toàn itemTemplate như INLINE.
     * Renderer runtime sẽ thay loop variable bằng ai_product.
     */
    if (
      token.kind ===
        "LIQUID_TAG" &&
      token.name ===
        "content_for"
    ) {
      const parsed =
        parseContentForArguments(
          token.markup ??
            "",
        );

      if (
        parsed.mode ===
          "block" ||
        parsed.mode ===
          "blocks"
      ) {
        for (
          const argument
          of parsed.arguments
        ) {
          const resourceArgument =
            argument.name ===
              "closest.product" ||
            argument.name ===
              "context.product";

          if (
            !resourceArgument
          ) {
            continue;
          }

          const directVariable =
            isDirectVariableExpression(
              argument.expression,
            );

          if (
            !directVariable
          ) {
            continue;
          }

          const origin =
            resolveItemOrigin(
              directVariable,
              token,
              bindings,
            );

          if (!origin) {
            continue;
          }

          const branch =
            activeBranchEvidence(
              token,
              origin,
              bindings,
              branchStates,
            );

          inlineProductUsages.push({
            tokenIndex:
              token.index,

            sourceFile:
              options.sourceFile,

            expression:
              argument.expression,

            sourceVariable:
              directVariable,

            loopVariable:
              origin.loopVariable,

            loopTokenIndex:
              origin.loopTokenIndex,

            productBranchProven:
              branch.proven,

            branchEvidence: [
              `CONTENT_FOR_${parsed.mode.toUpperCase()}:${argument.name}`,
              ...branch.evidence,
            ],

            htmlAncestors:
              token.htmlAncestors,

            liquidAncestors:
              token.liquidAncestors,
          });

          /**
           * Một content_for call chỉ cần một product resource binding.
           * Không nhân đôi candidate nếu theme truyền cùng product qua
           * cả closest.product và context.product.
           */
          break;
        }
      }

      continue;
    }

    /**
     * render / include
     */
    if (
      token.kind ===
        "LIQUID_TAG" &&
      (
        token.name ===
          "render" ||
        token.name ===
          "include"
      )
    ) {
      const parsed =
        parseRenderArguments(
          token.markup ?? "",
        );

      const args:
        RenderArgumentFlow[] = [];

      let productBinding:
        ProductBindingFlow | undefined;

      let bindingOrigin:
        Extract<
          DataFlowOrigin,
          {
            kind:
              "SEARCH_RESULT_ITEM";
          }
        > | null = null;

      for (
        const argument
        of parsed.arguments
      ) {
        const directVariable =
          isDirectVariableExpression(
            argument.expression,
          );

        const origin =
          directVariable
            ? resolveItemOrigin(
                directVariable,
                token,
                bindings,
              )
            : null;

        args.push({
          name:
            argument.name,

          expression:
            argument.expression,

          receivesSearchResult:
            Boolean(origin),

          sourceVariable:
            origin
              ? directVariable ??
                undefined
              : undefined,
        });

        /**
         * __for__ là render-for collection,
         * không coi là direct product object.
         */
        if (
          origin &&
          !argument.name.startsWith(
            "__for__",
          ) &&
          !productBinding
        ) {
          productBinding = {
            sourceVariable:
              directVariable!,

            argument:
              argument.name,

            loopVariable:
              origin.loopVariable,

            loopTokenIndex:
              origin.loopTokenIndex,
          };

          bindingOrigin =
            origin;
        }
      }

      /**
       * Chỉ ghi RendererCall khi:
       *
       * 1. invocation nhận trực tiếp object bắt nguồn từ search.results; và
       * 2. compiler chứng minh invocation đang nằm trong product-only branch.
       *
       * Ví dụ:
       *
       *   case item.object_type
       *     when 'product'
       *       render 'card-product', card_product: item
       *     when 'article'
       *       render 'article-card', article: item
       *
       * Cả hai render đều nhận cùng search-result item, nhưng chỉ card-product
       * là product renderer. Không đưa article/page branch sang candidate compiler
       * rồi mới reject ở bước sau.
       */
      if (
        productBinding &&
        bindingOrigin
      ) {
        const branch =
          activeBranchEvidence(
            token,
            bindingOrigin,
            bindings,
            branchStates,
          );

        if (branch.proven) {
          rendererCalls.push({
            tokenIndex:
              token.index,

            sourceFile:
              options.sourceFile,

            invocation:
              token.name ===
              "include"
                ? "INCLUDE"
                : "RENDER",

            raw:
              token.raw,

            snippetName:
              parsed.snippetName,

            snippetExpression:
              parsed.snippetExpression,

            arguments:
              args,

            productBinding,

            productBranchProven:
              true,

            branchEvidence:
              branch.evidence,

            liquidAncestors:
              token.liquidAncestors,

            htmlAncestors:
              token.htmlAncestors,
          });
        }
      }

      continue;
    }

    /**
     * INLINE renderer detection support.
     *
     * {{ item.title }}
     * {{ item.url }}
     * {{ item.price | money }}
     */
    if (
      token.kind ===
      "LIQUID_OUTPUT"
    ) {
      const expression =
        token.raw
          .replace(
            /^\{\{-?/,
            "",
          )
          .replace(
            /-?\}\}$/,
            "",
          )
          .trim();

      const resolved =
        rootExpressionBinding(
          expression,
          token,
          bindings,
        );

      if (resolved) {
        const branch =
          activeBranchEvidence(
            token,
            resolved.origin,
            bindings,
            branchStates,
          );

        inlineProductUsages.push({
          tokenIndex:
            token.index,

          sourceFile:
            options.sourceFile,

          expression,

          sourceVariable:
            resolved.variable,

          loopVariable:
            resolved.origin
              .loopVariable,

          loopTokenIndex:
            resolved.origin
              .loopTokenIndex,

          productBranchProven:
            branch.proven,

          branchEvidence:
            branch.evidence,

          htmlAncestors:
            token.htmlAncestors,

          liquidAncestors:
            token.liquidAncestors,
        });
      }
    }
  }

  return {
    sourceFile:
      options.sourceFile,

    rendererCalls,

    inlineProductUsages,

    bindings,
  };
}