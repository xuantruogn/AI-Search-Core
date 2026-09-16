import { createHash } from "node:crypto";

import {
  parseLiquidDocument,
  type HtmlAttribute,
  type HtmlFrame,
  type LiquidToken,
  type ParsedLiquidDocument,
} from "./liquid-ast.server";

import {
  analyzeSearchResultDataFlow,
  type DiscoveredRendererCall,
  type InlineProductUsage,
} from "./theme-data-flow.server";

import {
  buildThemeDependencyGraph,
  scanLiquidDependencies,
  type ThemeSourceFile,
} from "./theme-dependency-graph.server";

import {
  analyzeRendererContext,
  type ThemeSettingResolver,
} from "./theme-context-analyzer.server";

import {
  compileThemeMount,
  type ThemeMountCompileResult,
} from "./theme-mount-compiler.server";

import {
  analyzeThemeRendererRuntime,
} from "./theme-runtime-analyzer.server";

import {
  THEME_MAP_V4_DEFAULT_PAGE_SIZE,
  THEME_MAP_V4_VERSION,
  type RendererContextClass,
  type ThemeArgumentValue,
  type ThemeDependency,
  type ThemeMapV4,
  type ThemeMapV4SearchIdentity,
  type ThemeMapV4ThemeIdentity,
  type ThemeMountRecipe,
  type ThemeRendererCandidate,
} from "./theme-map-v4.types";

export interface CompileThemeBlockInstance {
  id: string;

  type: string;

  blocks:
    CompileThemeBlockInstance[];
}

export interface CompileThemeMapV4Input {
  theme: ThemeMapV4ThemeIdentity;

  search: ThemeMapV4SearchIdentity;

  /**
   * Liquid file thực sự chứa search.results.
   *
   * Ví dụ:
   *
   * sections/main-search.liquid
   * sections/search-results.liquid
   * sections/abc.liquid
   */
  sourceFile: string;

  source: string;

  /**
   * Chỉ các file theme đã được đọc theo dependency graph.
   *
   * Không scan toàn theme.
   */
  files: ThemeSourceFile[];

  /**
   * Theme Block tree thật của section instance
   * lấy từ templates/search.json.
   *
   * Không đoán block.
   */
  themeBlocks?:
    CompileThemeBlockInstance[];

  settingResolver?:
    ThemeSettingResolver;
}

interface DependencyCollection {
  filenames: string[];

  missing: string[];

  dynamic: string[];

  usesAllProducts: boolean;
}

interface ResolvedArguments {
  values: Record<
    string,
    ThemeArgumentValue
  >;

  rejectionReasons:
    string[];

  usedResolver:
    boolean;
}

function normalizeFilename(
  filename: string,
): string {
  return filename
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .toLowerCase();
}

function findFile(
  files: ThemeSourceFile[],
  filename: string,
): ThemeSourceFile | undefined {
  const wanted =
    normalizeFilename(
      filename,
    );

  return files.find(
    (file) =>
      normalizeFilename(
        file.filename,
      ) === wanted,
  );
}

function ensureSourceFile(
  input: CompileThemeMapV4Input,
): ThemeSourceFile[] {
  if (
    findFile(
      input.files,
      input.sourceFile,
    )
  ) {
    return input.files;
  }

  return [
    ...input.files,

    {
      filename:
        input.sourceFile,

      content:
        input.source,
    },
  ];
}

function snippetFilename(
  snippet: string,
): string {
  const name =
    snippet
      .trim()
      .replace(
        /^snippets\//i,
        "",
      )
      .replace(
        /\.liquid$/i,
        "",
      );

  return `snippets/${name}.liquid`;
}

function sha256(
  value: string,
): string {
  return createHash(
    "sha256",
  )
    .update(value)
    .digest("hex");
}

function checksumFile(
  file: ThemeSourceFile,
): string {
  return (
    file.checksum ??
    sha256(
      file.content,
    )
  );
}

function unique<T>(
  values: T[],
): T[] {
  return [
    ...new Set(
      values,
    ),
  ];
}

function parseLiteral(
  expression: string,
): ThemeArgumentValue | undefined {
  const value =
    expression.trim();

  if (
    (
      value.startsWith("'") &&
      value.endsWith("'")
    ) ||
    (
      value.startsWith('"') &&
      value.endsWith('"')
    )
  ) {
    return value.slice(
      1,
      -1,
    );
  }

  if (
    value ===
    "true"
  ) {
    return true;
  }

  if (
    value ===
    "false"
  ) {
    return false;
  }

  if (
    value ===
      "nil" ||
    value ===
      "null"
  ) {
    return null;
  }

  if (
    /^-?\d+(?:\.\d+)?$/.test(
      value,
    )
  ) {
    return Number(
      value,
    );
  }

  return undefined;
}

function resolveArgumentExpression(
  expression: string,
  resolver: ThemeSettingResolver,
): {
  resolved: boolean;

  value?:
    ThemeArgumentValue;

  usedResolver:
    boolean;
} {
  const literal =
    parseLiteral(
      expression,
    );

  if (
    literal !==
    undefined
  ) {
    return {
      resolved:
        true,

      value:
        literal,

      usedResolver:
        false,
    };
  }

  const normalized =
    expression.trim();

  if (
    normalized.startsWith(
      "section.settings.",
    )
  ) {
    const value =
      resolver
        .resolveSectionSetting?.(
          normalized,
        );

    if (
      value !==
      undefined
    ) {
      return {
        resolved:
          true,

        value,

        usedResolver:
          true,
      };
    }

    return {
      resolved:
        false,

      usedResolver:
        true,
    };
  }

  if (
    normalized.startsWith(
      "settings.",
    )
  ) {
    const value =
      resolver
        .resolveGlobalSetting?.(
          normalized,
        );

    if (
      value !==
      undefined
    ) {
      return {
        resolved:
          true,

        value,

        usedResolver:
          true,
      };
    }

    return {
      resolved:
        false,

      usedResolver:
        true,
    };
  }

  return {
    resolved:
      false,

    usedResolver:
      false,
  };
}

function resolveRendererArguments(
  call: DiscoveredRendererCall,
  resolver: ThemeSettingResolver,
): ResolvedArguments {
  const values: Record<
    string,
    ThemeArgumentValue
  > = {};

  const rejectionReasons:
    string[] = [];

  let usedResolver =
    false;

  for (
    const argument
    of call.arguments
  ) {
    /**
     * Product object sẽ được thay bằng ai_product.
     */
    if (
      argument
        .receivesSearchResult
    ) {
      continue;
    }

    /**
     * render ... for ...
     *
     * Đây là collection renderer,
     * chưa phải one-product-per-item.
     */
    if (
      argument.name.startsWith(
        "__for__",
      )
    ) {
      rejectionReasons.push(
        "RENDER_FOR_COLLECTION_NOT_SUPPORTED",
      );

      continue;
    }

    const resolution =
      resolveArgumentExpression(
        argument.expression,
        resolver,
      );

    usedResolver =
      usedResolver ||
      resolution.usedResolver;

    if (
      !resolution.resolved
    ) {
      rejectionReasons.push(
        `UNRESOLVED_RENDER_ARGUMENT:${argument.name}:${argument.expression}`,
      );

      continue;
    }

    values[
      argument.name
    ] =
      resolution.value ??
      null;
  }

  return {
    values,

    rejectionReasons,

    usedResolver,
  };
}

function dependencyUsesAllProducts(
  source: string,
): boolean {
  return (
    /\ball_products\s*\[/i.test(
      source,
    )
  );
}

/**
 * Follow dependency của INLINE fragment.
 */
function collectFragmentDependencies(
  fragment: string,
  files: ThemeSourceFile[],
): DependencyCollection {
  const scan =
    scanLiquidDependencies(
      fragment,
    );

  const queue =
    [...scan.dependencies];

  const dynamic =
    new Set(
      scan.dynamicDependencies,
    );

  const visited =
    new Set<string>();

  const missing =
    new Set<string>();

  let usesAllProducts =
    dependencyUsesAllProducts(
      fragment,
    );

  while (
    queue.length >
    0
  ) {
    const filename =
      queue.shift()!;

    const normalized =
      normalizeFilename(
        filename,
      );

    if (
      visited.has(
        normalized,
      )
    ) {
      continue;
    }

    visited.add(
      normalized,
    );

    const file =
      findFile(
        files,
        filename,
      );

    if (!file) {
      missing.add(
        filename,
      );

      continue;
    }

    if (
      dependencyUsesAllProducts(
        file.content,
      )
    ) {
      usesAllProducts =
        true;
    }

    const nested =
      scanLiquidDependencies(
        file.content,
      );

    for (
      const dependency
      of nested.dependencies
    ) {
      queue.push(
        dependency,
      );
    }

    for (
      const dependency
      of nested.dynamicDependencies
    ) {
      dynamic.add(
        dependency,
      );
    }
  }

  return {
    filenames:
      [...visited],

    missing:
      [...missing],

    dynamic:
      [...dynamic],

    usesAllProducts,
  };
}

function collectSnippetDependencies(
  snippetFile: string,
  files: ThemeSourceFile[],
): DependencyCollection {
  const graph =
    buildThemeDependencyGraph({
      entryFile:
        snippetFile,

      files,
    });

  let usesAllProducts =
    false;

  for (
    const filename
    of graph.files
  ) {
    const file =
      findFile(
        files,
        filename,
      );

    if (
      file &&
      dependencyUsesAllProducts(
        file.content,
      )
    ) {
      usesAllProducts =
        true;
    }
  }

  return {
    filenames:
      graph.files,

    missing:
      graph.missing,

    dynamic:
      graph.dynamicDependencies,

    usesAllProducts,
  };
}

/**
 * Tìm wrapper ngoài cùng của một product item.
 */
function findItemWrapper(
  document: ParsedLiquidDocument,
  rendererTokenIndex: number,
  loopTokenIndex: number,
) {
  const token =
    document.tokens[
      rendererTokenIndex
    ];

  if (!token) {
    return undefined;
  }

  for (
    const frame
    of token.htmlAncestors
  ) {
    if (
      frame.tokenIndex <=
      loopTokenIndex
    ) {
      continue;
    }

    const openToken =
      document.tokens[
        frame.tokenIndex
      ];

    const closeIndex =
      openToken
        ?.matchingTokenIndex;

    if (
      closeIndex ==
      null
    ) {
      continue;
    }

    const closeToken =
      document.tokens[
        closeIndex
      ];

    const closesInsideLoop =
      closeToken
        .liquidAncestors
        .some(
          (ancestor) =>
            ancestor
              .tokenIndex ===
            loopTokenIndex,
        );

    if (
      closesInsideLoop
    ) {
      return frame;
    }
  }

  return undefined;
}

function itemTemplateForToken(
  document: ParsedLiquidDocument,
  rendererTokenIndex: number,
  loopTokenIndex: number,
): string {
  const token =
    document.tokens[
      rendererTokenIndex
    ];

  if (!token) {
    return "";
  }

  const wrapper =
    findItemWrapper(
      document,
      rendererTokenIndex,
      loopTokenIndex,
    );

  if (!wrapper) {
    return token.raw;
  }

  const open =
    document.tokens[
      wrapper.tokenIndex
    ];

  const closeIndex =
    open
      .matchingTokenIndex;

  if (
    closeIndex ==
    null
  ) {
    return token.raw;
  }

  const close =
    document.tokens[
      closeIndex
    ];

  return document.source.slice(
    open.start,
    close.end,
  );
}

function candidateId(
  sourceFile: string,
  type:
    | "SNIPPET"
    | "INLINE",
  tokenIndex: number,
  discriminator: string,
): string {
  return sha256(
    [
      normalizeFilename(
        sourceFile,
      ),

      type,

      tokenIndex,

      discriminator,
    ].join(":"),
  ).slice(
    0,
    16,
  );
}

function mergeContextClass(
  contextClass:
    RendererContextClass,
  usedResolver: boolean,
): RendererContextClass {
  if (
    contextClass ===
    "CONTEXTUAL"
  ) {
    return "CONTEXTUAL";
  }

  if (
    contextClass ===
      "RESOLVABLE" ||
    usedResolver
  ) {
    return "RESOLVABLE";
  }

  return "PORTABLE";
}

function scoreCandidate(
  candidate:
    ThemeRendererCandidate,
): number {
  let score = 0;

  if (
    candidate.status ===
    "ELIGIBLE"
  ) {
    score += 100;
  }

  if (
    candidate.mount
  ) {
    score += 25;
  }

  if (
    candidate
      .contextClass ===
    "PORTABLE"
  ) {
    score += 20;
  } else if (
    candidate
      .contextClass ===
    "RESOLVABLE"
  ) {
    score += 10;
  }

  if (
    candidate.type ===
    "SNIPPET"
  ) {
    score += 10;
  }

  if (
    candidate.runtime.mode ===
      "STATIC" ||
    candidate.runtime.mode ===
      "CUSTOM_ELEMENT"
  ) {
    score += 10;
  }

  if (
    candidate
      .usesAllProducts
  ) {
    score -= 100;
  }

  return score;
}

function sourceForDependencies(
  filenames: string[],
  files: ThemeSourceFile[],
): string {
  return filenames
    .map(
      (filename) =>
        findFile(
          files,
          filename,
        )?.content ??
        "",
    )
    .join("\n");
}

/**
 * File cấu trúc bắt buộc phải nằm trong fingerprint.
 */
function structuralDependencies(
  input: CompileThemeMapV4Input,
): string[] {
  return unique(
    [
      input.search
        .templateFile,

      input.search
        .sectionFile,

      input.sourceFile,
    ].filter(
      (
        value,
      ): value is string =>
        Boolean(value),
    ),
  );
}

interface CandidateMountResolution {
  mount:
    ThemeMountCompileResult;

  dependencies:
    string[];
}

interface ForwardedMountProof {
  mount:
    ThemeMountRecipe;

  dependencies:
    string[];
}

function cssSelectorString(
  value: string,
): string {
  return value
    .replace(
      /\\/g,
      "\\\\",
    )
    .replace(
      /"/g,
      '\\"',
    );
}

function staticAttribute(
  attributes:
    HtmlAttribute[] |
    undefined,
  name: string,
): HtmlAttribute | null {
  const wanted =
    name.toLowerCase();

  const attribute =
    (
      attributes ??
      []
    ).find(
      (candidate) =>
        candidate.name
          .toLowerCase() ===
        wanted,
    );

  if (
    !attribute ||
    attribute.dynamic
  ) {
    return null;
  }

  return attribute;
}

function htmlOpenTokensForMount(
  document: ParsedLiquidDocument,
): LiquidToken[] {
  return document.tokens.filter(
    (token) =>
      token.kind ===
        "HTML_OPEN" &&
      typeof token.tagName ===
        "string",
  );
}

function strongFrameSelector(
  document: ParsedLiquidDocument,
  frame: HtmlFrame,
): {
  selector: string;

  strategy:
    | "ELEMENT_ID"
    | "DATA_ATTRIBUTE";
} | null {
  const id =
    staticAttribute(
      frame.attributes,
      "id",
    )?.value
      ?.trim();

  if (id) {
    const matches =
      htmlOpenTokensForMount(
        document,
      ).filter(
        (token) =>
          staticAttribute(
            token.attributes,
            "id",
          )?.value ===
          id,
      );

    if (
      matches.length ===
        1 &&
      matches[0].index ===
        frame.tokenIndex
    ) {
      const selector =
        /^[A-Za-z_][A-Za-z0-9_-]*$/.test(
          id,
        )
          ? `#${id}`
          : `[id="${cssSelectorString(
              id,
            )}"]`;

      return {
        selector,

        strategy:
          "ELEMENT_ID",
      };
    }
  }

  for (
    const attribute
    of frame.attributes
  ) {
    if (
      attribute.dynamic ||
      !attribute.name
        .toLowerCase()
        .startsWith(
          "data-",
        )
    ) {
      continue;
    }

    const selector =
      attribute.value ==
      null
        ? `[${attribute.name}]`
        : `[${attribute.name}="${cssSelectorString(
            attribute.value,
          )}"]`;

    const matches =
      htmlOpenTokensForMount(
        document,
      ).filter(
        (token) => {
          const candidate =
            staticAttribute(
              token.attributes,
              attribute.name,
            );

          if (!candidate) {
            return false;
          }

          return (
            candidate.value ===
            attribute.value
          );
        },
      );

    if (
      matches.length ===
        1 &&
      matches[0].index ===
        frame.tokenIndex
    ) {
      return {
        selector,

        strategy:
          "DATA_ATTRIBUTE",
      };
    }
  }

  return null;
}

function directOutputExpression(
  token: LiquidToken,
): string | null {
  if (
    token.kind !==
    "LIQUID_OUTPUT"
  ) {
    return null;
  }

  const markup =
    token.markup
      ?.trim();

  if (markup) {
    return markup;
  }

  const raw =
    token.raw.trim();

  const match =
    raw.match(
      /^\{\{-?\s*([\s\S]*?)\s*-?\}\}$/,
    );

  return (
    match?.[1]
      ?.trim() ??
    null
  );
}

function directOutputMount(
  document: ParsedLiquidDocument,
  token: LiquidToken,
  args: {
    sourceFile: string;

    sectionKey?:
      string;

    sectionType?:
      string;
  },
): ThemeMountRecipe | null {
  const ancestors =
    [
      ...token
        .htmlAncestors,
    ].reverse();

  for (
    const frame
    of ancestors
  ) {
    const proven =
      strongFrameSelector(
        document,
        frame,
      );

    if (!proven) {
      continue;
    }

    return {
      sectionKey:
        args.sectionKey,

      sectionType:
        args.sectionType,

      strategy:
        proven.strategy,

      selector:
        proven.selector,

      sourceFile:
        args.sourceFile,

      verification: {
        expectedTag:
          frame.tagName
            .toLowerCase(),

        expectedMatchCount:
          1,
      },
    };
  }

  return null;
}

function splitForwardingArguments(
  input: string,
): string[] {
  const parts:
    string[] = [];

  let quote:
    "'" | '"' | null =
    null;

  let depth =
    0;

  let start =
    0;

  for (
    let index = 0;
    index <
    input.length;
    index += 1
  ) {
    const char =
      input[index];

    if (quote) {
      if (
        char ===
          "\\" &&
        index + 1 <
          input.length
      ) {
        index += 1;

        continue;
      }

      if (
        char ===
        quote
      ) {
        quote =
          null;
      }

      continue;
    }

    if (
      char ===
        "'" ||
      char ===
        '"'
    ) {
      quote =
        char;

      continue;
    }

    if (
      char ===
        "(" ||
      char ===
        "[" ||
      char ===
        "{"
    ) {
      depth += 1;

      continue;
    }

    if (
      char ===
        ")" ||
      char ===
        "]" ||
      char ===
        "}"
    ) {
      depth =
        Math.max(
          0,
          depth - 1,
        );

      continue;
    }

    if (
      char ===
        "," &&
      depth ===
        0
    ) {
      parts.push(
        input.slice(
          start,
          index,
        ).trim(),
      );

      start =
        index + 1;
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

function escapeRegularExpression(
  value: string,
): string {
  return value.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
}

function literalSnippetForwarding(
  markup: string,
  sourceVariable: string,
): {
  snippetName: string;

  targetVariable:
    string;
} | null {
  const head =
    markup
      .trim()
      .match(
        /^(['"])(.*?)\1([\s\S]*)$/,
      );

  if (!head) {
    return null;
  }

  const snippetName =
    head[2].trim();

  if (!snippetName) {
    return null;
  }

  const rest =
    head[3]
      .trim()
      .replace(
        /^,/,
        "",
      )
      .trim();

  const source =
    escapeRegularExpression(
      sourceVariable,
    );

  const withMatch =
    rest.match(
      new RegExp(
        `^with\\s+${source}\\s+as\\s+([A-Za-z_][A-Za-z0-9_-]*)(?:\\s*,|$)`,
        "i",
      ),
    );

  if (withMatch) {
    return {
      snippetName,

      targetVariable:
        withMatch[1],
    };
  }

  for (
    const part
    of splitForwardingArguments(
      rest,
    )
  ) {
    const named =
      part.match(
        /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*([\s\S]+)$/,
      );

    if (!named) {
      continue;
    }

    if (
      named[2].trim() !==
      sourceVariable
    ) {
      continue;
    }

    return {
      snippetName,

      targetVariable:
        named[1],
    };
  }

  return null;
}

function variableRedefinedBefore(
  document: ParsedLiquidDocument,
  variable: string,
  startTokenIndex: number,
  targetTokenIndex: number,
): boolean {
  for (
    const token
    of document.tokens
  ) {
    if (
      token.index <=
        startTokenIndex ||
      token.index >=
        targetTokenIndex ||
      token.kind !==
        "LIQUID_TAG"
    ) {
      continue;
    }

    const name =
      token.name ??
      "";

    const markup =
      token.markup
        ?.trim() ??
      "";

    if (
      name ===
        "capture" &&
      markup ===
        variable
    ) {
      return true;
    }

    if (
      name ===
        "assign" &&
      new RegExp(
        `^${escapeRegularExpression(
          variable,
        )}\\s*=`,
      ).test(
        markup,
      )
    ) {
      return true;
    }
  }

  return false;
}

function nearestCaptureForLoop(
  document: ParsedLiquidDocument,
  loopTokenIndex: number,
): {
  variable: string;

  closeTokenIndex:
    number;
} | null {
  let best:
    LiquidToken | null =
    null;

  for (
    const token
    of document.tokens
  ) {
    if (
      token.kind !==
        "LIQUID_TAG" ||
      token.name !==
        "capture" ||
      token
        .matchingTokenIndex ==
        null ||
      token.index >=
        loopTokenIndex ||
      token
        .matchingTokenIndex <=
        loopTokenIndex
    ) {
      continue;
    }

    const variable =
      token.markup
        ?.trim() ??
      "";

    if (
      !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(
        variable,
      )
    ) {
      continue;
    }

    if (
      !best ||
      token.index >
        best.index
    ) {
      best =
        token;
    }
  }

  if (
    !best ||
    best
      .matchingTokenIndex ==
      null
  ) {
    return null;
  }

  return {
    variable:
      best.markup!
        .trim(),

    closeTokenIndex:
      best
        .matchingTokenIndex,
  };
}

function mountProofKey(
  proof: ForwardedMountProof,
): string {
  return [
    normalizeFilename(
      proof.mount
        .sourceFile,
    ),

    proof.mount
      .selector,

    proof.mount
      .verification
      .expectedTag,
  ].join(":");
}

function traceForwardedVariableMount(
  args: {
    document:
      ParsedLiquidDocument;

    sourceFile:
      string;

    variable:
      string;

    files:
      ThemeSourceFile[];

    sectionKey?:
      string;

    sectionType?:
      string;

    startTokenIndex:
      number;

    visited:
      Set<string>;

    depth:
      number;
  },
): ForwardedMountProof[] {
  if (
    args.depth >
    8
  ) {
    return [];
  }

  const stateKey =
    [
      normalizeFilename(
        args.sourceFile,
      ),

      args.variable,

      args.startTokenIndex,
    ].join(":");

  if (
    args.visited.has(
      stateKey,
    )
  ) {
    return [];
  }

  const visited =
    new Set(
      args.visited,
    );

  visited.add(
    stateKey,
  );

  const proofs:
    ForwardedMountProof[] =
      [];

  /**
   * Variable output trực tiếp.
   */
  for (
    const token
    of args.document.tokens
  ) {
    if (
      token.index <=
        args.startTokenIndex ||
      directOutputExpression(
        token,
      ) !==
        args.variable ||
      variableRedefinedBefore(
        args.document,
        args.variable,
        args.startTokenIndex,
        token.index,
      )
    ) {
      continue;
    }

    const mount =
      directOutputMount(
        args.document,
        token,
        {
          sourceFile:
            args.sourceFile,

          sectionKey:
            args.sectionKey,

          sectionType:
            args.sectionType,
        },
      );

    if (mount) {
      proofs.push({
        mount,

        dependencies: [
          args.sourceFile,
        ],
      });
    }
  }

  /**
   * Variable forward qua render/include.
   */
  for (
    const token
    of args.document.tokens
  ) {
    if (
      token.index <=
        args.startTokenIndex ||
      token.kind !==
        "LIQUID_TAG" ||
      (
        token.name !==
          "render" &&
        token.name !==
          "include"
      ) ||
      variableRedefinedBefore(
        args.document,
        args.variable,
        args.startTokenIndex,
        token.index,
      )
    ) {
      continue;
    }

    const forwarding =
      literalSnippetForwarding(
        token.markup ??
          "",
        args.variable,
      );

    if (!forwarding) {
      continue;
    }

    const targetFileName =
      snippetFilename(
        forwarding.snippetName,
      );

    const targetFile =
      findFile(
        args.files,
        targetFileName,
      );

    if (!targetFile) {
      continue;
    }

    const targetDocument =
      parseLiquidDocument(
        targetFile.content,
      );

    const nested =
      traceForwardedVariableMount({
        document:
          targetDocument,

        sourceFile:
          targetFile.filename,

        variable:
          forwarding.targetVariable,

        files:
          args.files,

        sectionKey:
          args.sectionKey,

        sectionType:
          args.sectionType,

        startTokenIndex:
          -1,

        visited,

        depth:
          args.depth + 1,
      });

    for (
      const proof
      of nested
    ) {
      proofs.push({
        mount:
          proof.mount,

        dependencies:
          unique([
            targetFile.filename,

            ...proof
              .dependencies,
          ]),
      });
    }
  }

  return proofs;
}

function compileCapturedFlowMount(
  args: {
    document:
      ParsedLiquidDocument;

    itemLoopTokenIndex:
      number;

    files:
      ThemeSourceFile[];

    sourceFile:
      string;

    sectionKey?:
      string;

    sectionType?:
      string;
  },
): ForwardedMountProof | null {
  const capture =
    nearestCaptureForLoop(
      args.document,
      args.itemLoopTokenIndex,
    );

  if (!capture) {
    return null;
  }

  const proofs =
    traceForwardedVariableMount({
      document:
        args.document,

      sourceFile:
        args.sourceFile,

      variable:
        capture.variable,

      files:
        args.files,

      sectionKey:
        args.sectionKey,

      sectionType:
        args.sectionType,

      startTokenIndex:
        capture.closeTokenIndex,

      visited:
        new Set(),

      depth:
        0,
    });

  const uniqueProofs =
    new Map<
      string,
      ForwardedMountProof
    >();

  for (
    const proof
    of proofs
  ) {
    const key =
      mountProofKey(
        proof,
      );

    const existing =
      uniqueProofs.get(
        key,
      );

    if (!existing) {
      uniqueProofs.set(
        key,
        proof,
      );

      continue;
    }

    existing.dependencies =
      unique([
        ...existing
          .dependencies,

        ...proof
          .dependencies,
      ]);
  }

  if (
    uniqueProofs.size !==
    1
  ) {
    return null;
  }

  return [
    ...uniqueProofs
      .values(),
  ][0];
}

function compileCandidateMount(
  args: {
    document:
      ParsedLiquidDocument;

    rendererTokenIndex:
      number;

    itemLoopTokenIndex:
      number;

    sourceFile:
      string;

    files:
      ThemeSourceFile[];

    sectionKey?:
      string;

    sectionType?:
      string;
  },
): CandidateMountResolution {
  const direct =
    compileThemeMount({
      document:
        args.document,

      rendererTokenIndex:
        args.rendererTokenIndex,

      itemLoopTokenIndex:
        args.itemLoopTokenIndex,

      sourceFile:
        args.sourceFile,

      sectionKey:
        args.sectionKey,

      sectionType:
        args.sectionType,
    });

  if (
    direct.status ===
    "PROVEN"
  ) {
    return {
      mount:
        direct,

      dependencies:
        [],
    };
  }

  const forwarded =
    compileCapturedFlowMount({
      document:
        args.document,

      itemLoopTokenIndex:
        args.itemLoopTokenIndex,

      files:
        args.files,

      sourceFile:
        args.sourceFile,

      sectionKey:
        args.sectionKey,

      sectionType:
        args.sectionType,
    });

  if (!forwarded) {
    return {
      mount:
        direct,

      dependencies:
        [],
    };
  }

  return {
    mount: {
      status:
        "PROVEN",

      mount:
        forwarded.mount,
    },

    dependencies:
      forwarded.dependencies,
  };
}

function compileSnippetCandidate(
  options: {
    input:
      CompileThemeMapV4Input;

    files:
      ThemeSourceFile[];

    document:
      ParsedLiquidDocument;

    call:
      DiscoveredRendererCall;
  },
): ThemeRendererCandidate {
  const {
    input,
    files,
    document,
    call,
  } =
    options;

  const rejectionReasons =
    new Set<string>();

  if (
    !call
      .productBranchProven
  ) {
    rejectionReasons.add(
      "PRODUCT_BRANCH_NOT_PROVEN",
    );
  }

  if (
    !call.snippetName
  ) {
    rejectionReasons.add(
      "DYNAMIC_OR_MISSING_SNIPPET_NAME",
    );
  }

  if (
    !call.productBinding
  ) {
    rejectionReasons.add(
      "PRODUCT_BINDING_NOT_PROVEN",
    );
  }

  const snippetFile =
    call.snippetName
      ? snippetFilename(
          call.snippetName,
        )
      : "";

  const snippet =
    snippetFile
      ? findFile(
          files,
          snippetFile,
        )
      : undefined;

  if (
    call.snippetName &&
    !snippet
  ) {
    rejectionReasons.add(
      `SNIPPET_NOT_FOUND:${snippetFile}`,
    );
  }

  const itemTemplate =
    call.productBinding
      ? itemTemplateForToken(
          document,

          call.tokenIndex,

          call
            .productBinding
            .loopTokenIndex,
        )
      : call.raw;

  const argumentResult =
    resolveRendererArguments(
      call,

      input.settingResolver ??
        {},
    );

  for (
    const reason
    of argumentResult
      .rejectionReasons
  ) {
    rejectionReasons.add(
      reason,
    );
  }

  const productArgument =
    call.productBinding
      ?.argument;

  if (
    !productArgument
  ) {
    rejectionReasons.add(
      "PRODUCT_ARGUMENT_NOT_PROVEN",
    );
  }

  const context =
    analyzeRendererContext({
      source:
        snippet?.content ??
        "",

      productVariable:
        productArgument ??
        "__unknown_product__",

      explicitArguments:
        call.arguments.map(
          (argument) =>
            argument.name,
        ),

      settingResolver:
        input.settingResolver,
    });

  for (
    const reason
    of context
      .rejectionReasons
  ) {
    rejectionReasons.add(
      reason,
    );
  }

  const dependencyInfo =
    snippetFile
      ? collectSnippetDependencies(
          snippetFile,
          files,
        )
      : {
          filenames:
            [],

          missing:
            [],

          dynamic:
            [],

          usesAllProducts:
            false,
        };

  for (
    const missing
    of dependencyInfo
      .missing
  ) {
    rejectionReasons.add(
      `MISSING_DEPENDENCY:${missing}`,
    );
  }

  for (
    const dynamic
    of dependencyInfo
      .dynamic
  ) {
    rejectionReasons.add(
      `DYNAMIC_DEPENDENCY:${dynamic}`,
    );
  }

  if (
    dependencyInfo
      .usesAllProducts
  ) {
    rejectionReasons.add(
      "USES_ALL_PRODUCTS_IN_RENDERER_DEPENDENCY",
    );
  }

  const mountResolution =
    call.productBinding
      ? compileCandidateMount({
          document,

          rendererTokenIndex:
            call.tokenIndex,

          itemLoopTokenIndex:
            call
              .productBinding
              .loopTokenIndex,

          sourceFile:
            input.sourceFile,

          files,

          sectionKey:
            input.search
              .sectionKey,

          sectionType:
            input.search
              .sectionType,
        })
      : {
          mount: {
            status:
              "UNSUPPORTED" as const,

            reason:
              "PRODUCT_LOOP_NOT_PROVEN",
          },

          dependencies:
            [],
        };

  const mount =
    mountResolution.mount;

  if (
    mount.status !==
    "PROVEN"
  ) {
    rejectionReasons.add(
      mount.reason ??
        "SOURCE_PROVEN_MOUNT_NOT_FOUND",
    );
  }

  const dependencyFiles =
    unique([
      ...structuralDependencies(
        input,
      ),

      ...dependencyInfo
        .filenames,

      ...mountResolution
        .dependencies,
    ]);

  const runtimeSource =
    [
      itemTemplate,

      sourceForDependencies(
        dependencyInfo
          .filenames,
        files,
      ),
    ].join("\n");

  const runtime =
    analyzeThemeRendererRuntime(
      runtimeSource,
    );

  /**
   * SNIPPET path hiện tại dùng App Proxy Liquid.
   */
  const renderStrategy:
    ThemeRendererCandidate["renderStrategy"] =
      "APP_PROXY_LIQUID";

  if (
    runtime.mode ===
      "UNSUPPORTED" ||
    runtime.mode ===
      "REQUIRES_REINIT"
  ) {
    rejectionReasons.add(
      `RUNTIME_${runtime.mode}`,
    );
  }

  const candidate:
    ThemeRendererCandidate =
    {
      id:
        candidateId(
          input.sourceFile,

          "SNIPPET",

          call.tokenIndex,

          call.snippetName ??
            call
              .snippetExpression,
        ),

      type:
        "SNIPPET",

      renderStrategy,

      sourceFile:
        input.sourceFile,

      snippet:
        call.snippetName ??
        undefined,

      productBinding: {
        sourceVariable:
          call
            .productBinding
            ?.sourceVariable ??
          "__unknown__",

        argument:
          call
            .productBinding
            ?.argument,
      },

      itemTemplate,

      arguments:
        argumentResult
          .values,

      contextClass:
        mergeContextClass(
          context.contextClass,

          argumentResult
            .usedResolver,
        ),

      dependencies:
        dependencyFiles,

      runtime: {
        mode:
          runtime.mode,

        customElement:
          runtime.customElement,
      },

      usesAllProducts:
        dependencyInfo
          .usesAllProducts,

      score:
        0,

      status:
        rejectionReasons.size ===
        0
          ? "ELIGIBLE"
          : "REJECTED",

      rejectionReasons:
        [
          ...rejectionReasons,
        ],

      mount:
        mount.status ===
        "PROVEN"
          ? mount.mount
          : undefined,
    };

  candidate.score =
    scoreCandidate(
      candidate,
    );

  return candidate;
}

function inlineGroupKey(
  usage: InlineProductUsage,
  document: ParsedLiquidDocument,
): string {
  const wrapper =
    findItemWrapper(
      document,
      usage.tokenIndex,
      usage.loopTokenIndex,
    );

  return [
    usage.loopTokenIndex,

    wrapper
      ?.tokenIndex ??
      usage.tokenIndex,
  ].join(":");
}

interface ResolvedThemeBlockInvocation {
  type:
    string;

  id:
    string;

  block:
    CompileThemeBlockInstance;
}

function escapeRegexLiteral(
  value: string,
): string {
  return value.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
}

function readLiteralNamedArgument(
  markup: string,
  argumentName: string,
): string | null {
  const escapedName =
    escapeRegexLiteral(
      argumentName,
    );

  const regex =
    new RegExp(
      `(?:^|,)\\s*${escapedName}\\s*:\\s*(['"])(.*?)\\1(?=\\s*(?:,|$))`,
      "is",
    );

  const match =
    markup.match(
      regex,
    );

  return (
    match?.[2]
      ?.trim() ||
    null
  );
}

function resolveThemeBlockInvocation(
  token:
    LiquidToken |
    undefined,
  productVariable: string,
  themeBlocks:
    CompileThemeBlockInstance[] |
    undefined,
): ResolvedThemeBlockInvocation | null {
  if (
    !token ||
    token.kind !==
      "LIQUID_TAG" ||
    token.name !==
      "content_for"
  ) {
    return null;
  }

  const markup =
    token.markup
      ?.trim() ??
    "";

  /**
   * Chỉ static Theme Block.
   *
   * content_for 'block',
   *   type: '_product-card',
   *   id: 'product-card',
   *   closest.product: product
   */
  if (
    !/^(['"])block\1(?:\s*,|\s*$)/i.test(
      markup,
    )
  ) {
    return null;
  }

  const type =
    readLiteralNamedArgument(
      markup,
      "type",
    );

  const id =
    readLiteralNamedArgument(
      markup,
      "id",
    );

  if (
    !type ||
    !id
  ) {
    return null;
  }

  const productPattern =
    new RegExp(
      `(?:^|,)\\s*(?:closest|context)\\.product\\s*:\\s*${escapeRegexLiteral(
        productVariable,
      )}(?=\\s*(?:,|$))`,
      "i",
    );

  if (
    !productPattern.test(
      markup,
    )
  ) {
    return null;
  }

  /**
   * Static block gọi trực tiếp từ section
   * phải match direct child section instance.
   */
  const matches =
    (
      themeBlocks ??
      []
    ).filter(
      (block) =>
        block.id ===
          id &&
        block.type ===
          type,
    );

  if (
    matches.length !==
    1
  ) {
    return null;
  }

  return {
    type,

    id,

    block:
      matches[0],
  };
}

function themeBlockFilename(
  type: string,
): string | null {
  const normalized =
    type.trim();

  if (
    !/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(
      normalized,
    )
  ) {
    return null;
  }

  return `blocks/${normalized}.liquid`;
}

function collectThemeBlockTreeFiles(
  root:
    CompileThemeBlockInstance,
): string[] {
  const result =
    new Set<string>();

  const visit = (
    block:
      CompileThemeBlockInstance,
  ) => {
    const filename =
      themeBlockFilename(
        block.type,
      );

    if (filename) {
      result.add(
        filename,
      );
    }

    for (
      const child
      of block.blocks
    ) {
      visit(
        child,
      );
    }
  };

  visit(
    root,
  );

  return [
    ...result,
  ];
}

function emptyDependencyCollection():
  DependencyCollection {
  return {
    filenames:
      [],

    missing:
      [],

    dynamic:
      [],

    usesAllProducts:
      false,
  };
}

/**
 * Dependency graph của đúng Theme Block subtree.
 *
 * Không scan toàn theme.
 */
function collectThemeBlockDependencies(
  root:
    CompileThemeBlockInstance,
  files:
    ThemeSourceFile[],
): DependencyCollection {
  const queue =
    collectThemeBlockTreeFiles(
      root,
    );

  const visited =
    new Set<string>();

  const missing =
    new Set<string>();

  const dynamic =
    new Set<string>();

  let usesAllProducts =
    false;

  while (
    queue.length >
    0
  ) {
    const filename =
      queue.shift()!;

    const normalized =
      normalizeFilename(
        filename,
      );

    if (
      visited.has(
        normalized,
      )
    ) {
      continue;
    }

    visited.add(
      normalized,
    );

    const file =
      findFile(
        files,
        filename,
      );

    if (!file) {
      missing.add(
        filename,
      );

      continue;
    }

    if (
      dependencyUsesAllProducts(
        file.content,
      )
    ) {
      usesAllProducts =
        true;
    }

    const scan =
      scanLiquidDependencies(
        file.content,
      );

    for (
      const dependency
      of scan.dependencies
    ) {
      queue.push(
        dependency,
      );
    }

    for (
      const dependency
      of scan.dynamicDependencies
    ) {
      dynamic.add(
        dependency,
      );
    }
  }

  return {
    filenames:
      [...visited],

    missing:
      [...missing],

    dynamic:
      [...dynamic],

    usesAllProducts,
  };
}

function compileInlineCandidate(
  options: {
    input:
      CompileThemeMapV4Input;

    files:
      ThemeSourceFile[];

    document:
      ParsedLiquidDocument;

    usages:
      InlineProductUsage[];
  },
): ThemeRendererCandidate {
  const {
    input,
    files,
    document,
    usages,
  } =
    options;

  const first =
    usages[0];

  const rejectionReasons =
    new Set<string>();

  if (
    usages.some(
      (usage) =>
        !usage
          .productBranchProven,
    )
  ) {
    rejectionReasons.add(
      "PRODUCT_BRANCH_NOT_PROVEN",
    );
  }

  const itemTemplate =
    itemTemplateForToken(
      document,

      first.tokenIndex,

      first.loopTokenIndex,
    );

  const context =
    analyzeRendererContext({
      source:
        itemTemplate,

      productVariable:
        first.sourceVariable,

      settingResolver:
        input.settingResolver,
    });

  for (
    const reason
    of context
      .rejectionReasons
  ) {
    rejectionReasons.add(
      reason,
    );
  }

  const rendererToken =
    document.tokens[
      first.tokenIndex
    ];

  /**
   * ============================================================
   * THEME BLOCK DETECTION
   * ============================================================
   */
  const themeBlockInvocation =
    resolveThemeBlockInvocation(
      rendererToken,

      first.sourceVariable,

      input.themeBlocks,
    );

  /**
   * Chiến lược render được quyết định từ source proof,
   * không từ filename/theme name.
   */
  const renderStrategy:
    ThemeRendererCandidate["renderStrategy"] =
      themeBlockInvocation
        ? "THEME_CONTEXT_REQUIRED"
        : "APP_PROXY_LIQUID";

  const dependencyInfo =
    collectFragmentDependencies(
      itemTemplate,
      files,
    );

  const themeBlockDependencyInfo =
    themeBlockInvocation
      ? collectThemeBlockDependencies(
          themeBlockInvocation
            .block,
          files,
        )
      : emptyDependencyCollection();

  const missingDependencies =
    new Set([
      ...dependencyInfo
        .missing,

      ...themeBlockDependencyInfo
        .missing,
    ]);

  for (
    const missing
    of missingDependencies
  ) {
    rejectionReasons.add(
      `MISSING_DEPENDENCY:${missing}`,
    );
  }

  const dynamicDependencies =
    new Set([
      ...dependencyInfo
        .dynamic,

      ...themeBlockDependencyInfo
        .dynamic,
    ]);

  /**
   * content_for 'blocks' đã được giải bằng
   * JSON Theme Block subtree thật.
   *
   * Vì vậy không còn coi nó là unknown dynamic.
   */
  if (
    themeBlockInvocation
  ) {
    dynamicDependencies.delete(
      "content_for:blocks",
    );
  }

  for (
    const dynamic
    of dynamicDependencies
  ) {
    rejectionReasons.add(
      `DYNAMIC_DEPENDENCY:${dynamic}`,
    );
  }

  const usesAllProducts =
    dependencyInfo
      .usesAllProducts ||
    themeBlockDependencyInfo
      .usesAllProducts;

  if (
    usesAllProducts
  ) {
    rejectionReasons.add(
      "USES_ALL_PRODUCTS_IN_RENDERER_DEPENDENCY",
    );
  }

  /**
   * Theme Block cần section/block context thật.
   *
   * Không được đưa vào App Proxy Liquid renderer.
   */
  if (
    renderStrategy ===
    "THEME_CONTEXT_REQUIRED"
  ) {
    rejectionReasons.add(
      "THEME_CONTEXT_REQUIRED",
    );
  }

  const mountResolution =
    compileCandidateMount({
      document,

      rendererTokenIndex:
        first.tokenIndex,

      itemLoopTokenIndex:
        first.loopTokenIndex,

      sourceFile:
        input.sourceFile,

      files,

      sectionKey:
        input.search
          .sectionKey,

      sectionType:
        input.search
          .sectionType,
    });

  const mount =
    mountResolution.mount;

  if (
    mount.status !==
    "PROVEN"
  ) {
    rejectionReasons.add(
      mount.reason ??
        "SOURCE_PROVEN_MOUNT_NOT_FOUND",
    );
  }

  const dependencyFiles =
    unique([
      ...structuralDependencies(
        input,
      ),

      ...dependencyInfo
        .filenames,

      ...themeBlockDependencyInfo
        .filenames,

      ...mountResolution
        .dependencies,
    ]);

  const runtimeSource =
    [
      itemTemplate,

      sourceForDependencies(
        dependencyFiles,
        files,
      ),
    ].join("\n");

  /**
   * Runtime analyzer vẫn chạy để lưu diagnostics.
   */
  const runtime =
    analyzeThemeRendererRuntime(
      runtimeSource,
    );

  /**
   * Nhưng runtime UNSUPPORTED chỉ là blocker của
   * APP_PROXY_LIQUID.
   *
   * THEME_CONTEXT_REQUIRED dùng một renderer path khác,
   * nên không được gắn RUNTIME_UNSUPPORTED sai ngữ cảnh.
   */
  if (
    renderStrategy ===
      "APP_PROXY_LIQUID" &&
    (
      runtime.mode ===
        "UNSUPPORTED" ||
      runtime.mode ===
        "REQUIRES_REINIT"
    )
  ) {
    rejectionReasons.add(
      `RUNTIME_${runtime.mode}`,
    );
  }

  const candidate:
    ThemeRendererCandidate =
    {
      id:
        candidateId(
          input.sourceFile,

          "INLINE",

          first.tokenIndex,

          inlineGroupKey(
            first,
            document,
          ),
        ),

      type:
        "INLINE",

      renderStrategy,

      sourceFile:
        input.sourceFile,

      productBinding: {
        sourceVariable:
          first.sourceVariable,
      },

      itemTemplate,

      arguments:
        {},

      contextClass:
        context.contextClass,

      dependencies:
        dependencyFiles,

      runtime: {
        mode:
          runtime.mode,

        customElement:
          runtime.customElement,
      },

      usesAllProducts,

      score:
        0,

      status:
        rejectionReasons.size ===
        0
          ? "ELIGIBLE"
          : "REJECTED",

      rejectionReasons:
        [
          ...rejectionReasons,
        ],

      mount:
        mount.status ===
        "PROVEN"
          ? mount.mount
          : undefined,
    };

  candidate.score =
    scoreCandidate(
      candidate,
    );

  return candidate;
}

function buildDependencyRecords(
  names: string[],
  files: ThemeSourceFile[],
): ThemeDependency[] {
  return unique(
    names.map(
      normalizeFilename,
    ),
  )
    .sort()
    .map(
      (
        normalized,
      ) => {
        const file =
          files.find(
            (candidate) =>
              normalizeFilename(
                candidate.filename,
              ) ===
              normalized,
          );

        if (!file) {
          return {
            filename:
              normalized,

            checksum:
              "MISSING",
          };
        }

        return {
          filename:
            file.filename,

          checksum:
            checksumFile(
              file,
            ),
        };
      },
    );
}

function fingerprintDependencies(
  dependencies:
    ThemeDependency[],
): string {
  return sha256(
    dependencies
      .map(
        (
          dependency,
        ) =>
          `${normalizeFilename(
            dependency.filename,
          )}:${dependency.checksum}`,
      )
      .sort()
      .join("\n"),
  );
}

export function compileThemeMapV4(
  input:
    CompileThemeMapV4Input,
): ThemeMapV4 {
  const files =
    ensureSourceFile(
      input,
    );

  const document =
    parseLiquidDocument(
      input.source,
    );

  const dataFlow =
    analyzeSearchResultDataFlow(
      document,
      {
        sourceFile:
          input.sourceFile,
      },
    );

  const candidates:
    ThemeRendererCandidate[] =
      [];

  /**
   * 1. Classic render/include snippet.
   */
  for (
    const call
    of dataFlow
      .rendererCalls
  ) {
    candidates.push(
      compileSnippetCandidate({
        input,

        files,

        document,

        call,
      }),
    );
  }

  /**
   * 2. Inline / Theme Block candidates.
   */
  const inlineGroups =
    new Map<
      string,
      InlineProductUsage[]
    >();

  for (
    const usage
    of dataFlow
      .inlineProductUsages
  ) {
    const key =
      inlineGroupKey(
        usage,
        document,
      );

    const list =
      inlineGroups.get(
        key,
      ) ??
      [];

    list.push(
      usage,
    );

    inlineGroups.set(
      key,
      list,
    );
  }

  for (
    const usages
    of inlineGroups
      .values()
  ) {
    candidates.push(
      compileInlineCandidate({
        input,

        files,

        document,

        usages,
      }),
    );
  }

  candidates.sort(
    (
      left,
      right,
    ) =>
      right.score -
        left.score ||
      left.id.localeCompare(
        right.id,
      ),
  );

  /**
   * Fingerprint của exact dependencies.
   */
  const dependencyNames =
    new Set<string>(
      structuralDependencies(
        input,
      ),
    );

  for (
    const candidate
    of candidates
  ) {
    for (
      const dependency
      of candidate
        .dependencies
    ) {
      dependencyNames.add(
        dependency,
      );
    }
  }

  const dependencies =
    buildDependencyRecords(
      [
        ...dependencyNames,
      ],

      files,
    );

  const fingerprint =
    fingerprintDependencies(
      dependencies,
    );

  /**
   * VERIFIED hiện tại chỉ nghĩa là:
   *
   * có renderer mà backend runtime hiện tại
   * thực sự render được.
   *
   * THEME_CONTEXT_REQUIRED chưa được tính VERIFIED
   * cho tới khi theme-context renderer path hoàn thành.
   */
  const hasEligible =
    candidates.some(
      (candidate) =>
        candidate.status ===
          "ELIGIBLE" &&
        candidate.mount !=
          null &&
        candidate
          .renderStrategy ===
          "APP_PROXY_LIQUID",
    );

  if (
    !hasEligible
  ) {
    return {
      version:
        THEME_MAP_V4_VERSION,

      theme:
        input.theme,

      search:
        input.search,

      rendererCandidates:
        candidates,

      dependencies,

      fingerprint,

      pageSize:
        THEME_MAP_V4_DEFAULT_PAGE_SIZE,

      status:
        "UNSUPPORTED",

      unsupportedReason:
        candidates.length ===
        0
          ? "PRODUCT_RENDERER_NOT_FOUND"
          : "NO_SAFE_RENDERER_CANDIDATE",
    };
  }

  return {
    version:
      THEME_MAP_V4_VERSION,

    theme:
      input.theme,

    search:
      input.search,

    rendererCandidates:
      candidates,

    dependencies,

    fingerprint,

    pageSize:
      THEME_MAP_V4_DEFAULT_PAGE_SIZE,

    status:
      "VERIFIED",
  };
}

/**
 * Runtime App Proxy hiện tại chỉ nhận:
 *
 * ELIGIBLE
 * +
 * APP_PROXY_LIQUID
 * +
 * source-proven mount.
 *
 * Defense-in-depth:
 * THEME_CONTEXT_REQUIRED tuyệt đối không lọt vào
 * App Proxy renderer.
 */
export function eligibleRendererCandidates(
  map: ThemeMapV4,
): ThemeRendererCandidate[] {
  return map
    .rendererCandidates
    .filter(
      (candidate) =>
        candidate.status ===
          "ELIGIBLE" &&
        candidate
          .renderStrategy ===
          "APP_PROXY_LIQUID" &&
        candidate.mount !=
          null,
    );
}