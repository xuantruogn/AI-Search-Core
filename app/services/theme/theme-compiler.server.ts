function expandLiquidBlocks(source: string) {
  // Shopify's `{% liquid %}` tag is heavily used by newer themes (including
  // Horizon-family themes). Expand it into analysis-only ordinary tags so the
  // same parser can see loops and snippet invocations. Continuation lines are
  // joined to the preceding statement, which also covers multiline `render`
  // calls without guessing any theme-specific syntax.
  const command = /^(?:assign|echo|capture|endcapture|case|when|endcase|if|elsif|else|endif|unless|endunless|for|endfor|tablerow|endtablerow|paginate|endpaginate|render|include|increment|decrement|cycle|break|continue)\b/i;

  return source.replace(
    /\{%-?\s*liquid\b([\s\S]*?)-?%\}/gi,
    (_match, body: string) => {
      const statements: string[] = [];

      for (const rawLine of body.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;

        if (command.test(line) || statements.length === 0) {
          statements.push(line);
        } else {
          statements[statements.length - 1] += ` ${line}`;
        }
      }

      return statements.map((statement) => `{% ${statement} %}`).join("\n");
    },
  );
}

function executableLiquidSource(liquid: string) {
  const withoutMetadata = liquid
    .replace(
      /\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/gi,
      " ",
    )
    // `{% doc %}` can contain executable-looking examples. They are
    // documentation only and must never become renderer candidates.
    .replace(
      /\{%-?\s*doc\s*-?%\}[\s\S]*?\{%-?\s*enddoc\s*-?%\}/gi,
      " ",
    )
    .replace(/\{%-?\s*schema\s*-?%\}[\s\S]*?\{%-?\s*endschema\s*-?%\}/gi, " ")
    .replace(
      /\{%-?\s*stylesheet\s*-?%\}[\s\S]*?\{%-?\s*endstylesheet\s*-?%\}/gi,
      " ",
    )
    .replace(
      /\{%-?\s*javascript\s*-?%\}[\s\S]*?\{%-?\s*endjavascript\s*-?%\}/gi,
      " ",
    )
    .replace(/<!--[\s\S]*?-->/g, " ");

  return expandLiquidBlocks(withoutMetadata);
}

export type LiquidInvocationTag = "render" | "include";
export type GridTag = "ul" | "ol" | "div";
export type ItemTag = "li" | "div" | "article";
export type ContainerTag = "div" | "section" | "main";

export type RendererProfile = {
  cardSnippet: string | null;
  productArgument: string | null;
  implicitProductVariable: string | null;
  invocationTag: LiquidInvocationTag;
  renderArguments: Record<string, string>;
  stylesheetAssets: string[];
  gridClass: string | null;
  itemClass: string | null;
  containerClass: string | null;
  gridTag: GridTag | null;
  itemTag: ItemTag | null;
  containerTag: ContainerTag | null;
  score: number;
  signals: string[];
};

export type RendererCandidate = {
  profile: RendererProfile;
  invocationIndex: number;
  signature: string;
};

export type SnippetCompatibility = {
  requiredParameters: string[];
  hardContextDependencies: string[];
  signals: string[];
};

type DocumentedParameter = {
  name: string;
  optional: boolean;
};

type HtmlTagMatch = {
  tag: string;
  className: string | null;
  index: number;
};

type LoopContext = {
  variable: string;
  iterable: string;
} | null;

function extractStylesheetAssets(liquid: string): string[] {
  const assets: string[] = [];
  const regex =
    /\{\{\s*['"]([^'"]+\.css)['"]\s*\|\s*asset_url\s*\|\s*stylesheet_tag\s*\}\}/g;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(liquid)) !== null) assets.push(match[1]);
  return [...new Set(assets)];
}

function staticClassNames(raw: string): string | null {
  const withoutLiquid = raw
    .replace(/\{\{[\s\S]*?\}\}/g, " ")
    .replace(/\{%[\s\S]*?%\}/g, " ");

  const tokens = withoutLiquid
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => /^[A-Za-z0-9_-]+$/.test(token))
    .filter((token) => !token.endsWith("-") && token.length > 0);

  return tokens.length ? [...new Set(tokens)].join(" ") : null;
}

function extractClassAttribute(attributes: string): string | null {
  const match = attributes.match(/\bclass\s*=\s*(["'])([\s\S]*?)\1/i);
  return match ? staticClassNames(match[2]) : null;
}

function openingTagsBefore(source: string, index: number, windowSize = 8_000) {
  const start = Math.max(0, index - windowSize);
  const text = source.slice(start, index);
  const regex = /<(\/?)(ul|ol|div|li|article|section|main)\b([^>]*)>/gi;
  const stack: HtmlTagMatch[] = [];

  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const closing = match[1] === "/";
    const tag = match[2].toLowerCase();

    if (closing) {
      // Keep only elements that are still open at the renderer invocation.
      // The old implementation considered every opening tag in the previous
      // 4k characters and could accidentally copy classes from an already
      // closed header/filter/card. Walking the lightweight HTML stack makes
      // wrapper discovery source-derived rather than nearest-tag guessing.
      for (let stackIndex = stack.length - 1; stackIndex >= 0; stackIndex -= 1) {
        if (stack[stackIndex].tag === tag) {
          stack.length = stackIndex;
          break;
        }
      }
      continue;
    }

    const raw = match[0];
    const selfClosing = /\/\s*>$/.test(raw);
    if (selfClosing) continue;

    stack.push({
      tag,
      className: extractClassAttribute(match[3]),
      index: start + match.index,
    });
  }

  return stack;
}

function classHasAny(className: string | null, words: string[]) {
  if (!className) return false;
  const lower = className.toLowerCase();
  return words.some((word) => lower.includes(word));
}

function extractWrappers(source: string, invocationIndex: number): {
  gridClass: string | null;
  itemClass: string | null;
  containerClass: string | null;
  gridTag: GridTag | null;
  itemTag: ItemTag | null;
  containerTag: ContainerTag | null;
} {
  const tags = openingTagsBefore(source, invocationIndex);

  let item: HtmlTagMatch | null = null;
  for (let i = tags.length - 1; i >= 0; i -= 1) {
    const tag = tags[i];
    if (tag.tag === "li" || tag.tag === "article") {
      item = tag;
      break;
    }
    if (
      tag.tag === "div" &&
      classHasAny(tag.className, ["grid__item", "product", "card", "item", "result"])
    ) {
      item = tag;
      break;
    }
  }

  let grid: HtmlTagMatch | null = null;
  const itemIndex = item?.index ?? invocationIndex;
  for (let i = tags.length - 1; i >= 0; i -= 1) {
    const tag = tags[i];
    if (tag.index >= itemIndex) continue;
    if (
      (tag.tag === "ul" || tag.tag === "ol" || tag.tag === "div") &&
      classHasAny(tag.className, ["grid", "products", "product-list", "results", "collection", "cards"])
    ) {
      grid = tag;
      break;
    }
  }

  if (!grid) {
    for (let i = tags.length - 1; i >= 0; i -= 1) {
      const tag = tags[i];
      if (tag.index >= itemIndex) continue;
      if (tag.tag === "ul" || tag.tag === "ol") {
        grid = tag;
        break;
      }
    }
  }

  let container: HtmlTagMatch | null = null;
  const gridIndex = grid?.index ?? itemIndex;
  for (let i = tags.length - 1; i >= 0; i -= 1) {
    const tag = tags[i];
    if (tag.index >= gridIndex) continue;
    if (
      (tag.tag === "div" || tag.tag === "section" || tag.tag === "main") &&
      classHasAny(tag.className, ["page-width", "container", "content-width", "section", "wrapper"])
    ) {
      container = tag;
      break;
    }
  }

  return {
    gridClass: grid?.className ?? null,
    itemClass: item?.className ?? null,
    containerClass: container?.className ?? null,
    gridTag:
      grid?.tag === "ul" || grid?.tag === "ol" || grid?.tag === "div"
        ? grid.tag
        : null,
    itemTag:
      item?.tag === "li" || item?.tag === "div" || item?.tag === "article"
        ? item.tag
        : null,
    containerTag:
      container?.tag === "div" ||
      container?.tag === "section" ||
      container?.tag === "main"
        ? container.tag
        : null,
  };
}

function documentedParameters(liquid: string): DocumentedParameter[] {
  const params: DocumentedParameter[] = [];
  const seen = new Set<string>();
  const docRegex = /\{%-?\s*doc\s*-?%\}([\s\S]*?)\{%-?\s*enddoc\s*-?%\}/gi;

  let docMatch: RegExpExecArray | null;
  while ((docMatch = docRegex.exec(liquid)) !== null) {
    const paramRegex = /@param\s+\{[^}]+\}\s+(\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_]*)/gi;
    let paramMatch: RegExpExecArray | null;
    while ((paramMatch = paramRegex.exec(docMatch[1])) !== null) {
      const raw = paramMatch[1].trim();
      const optional = raw.startsWith("[") && raw.endsWith("]");
      const name = optional
        ? raw.slice(1, -1).split("=")[0].trim()
        : raw;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || seen.has(name)) continue;
      seen.add(name);
      params.push({ name, optional });
    }
  }

  return params;
}

export function analyzeSnippetCompatibility(liquid: string): SnippetCompatibility {
  const source = executableLiquidSource(liquid);
  const requiredParameters = documentedParameters(liquid)
    .filter((param) => !param.optional)
    .map((param) => param.name);
  const hardContextDependencies: string[] = [];
  const signals: string[] = [];

  // Rendered snippets execute in an isolated variable scope. Globals such as
  // `settings`, `request`, `routes`, translations, and the product argument
  // are safe; section/block locals are not available in an App Proxy render.
  if (/\bblock\.(?:settings|id|shopify_attributes)\b/i.test(source)) {
    hardContextDependencies.push("block");
  }
  if (/\bsection\.(?:settings|id|index|location)\b/i.test(source)) {
    hardContextDependencies.push("section");
  }
  if (/\{%-?\s*content_for\b/i.test(source) || /\bclosest\./i.test(source)) {
    hardContextDependencies.push("theme-block-context");
  }
  if (
    /\{\{[-]?\s*children\b/i.test(source) &&
    !/\{%-?\s*(?:assign|capture)\s+children\b/i.test(source)
  ) {
    hardContextDependencies.push("children");
  }

  if (/\bsettings\./i.test(source)) signals.push("uses-global-theme-settings");
  if (/\brequest\./i.test(source)) signals.push("uses-request-global");
  if (/\|\s*(?:image_url|image_tag)\b/i.test(source)) signals.push("renders-media");
  if (/\bhref\s*=\s*["'][^"']*\{\{/i.test(source)) signals.push("renders-link");
  if (/\b(?:price|money)\b/i.test(source)) signals.push("renders-price");
  if (/\.[ ]*url\b/i.test(source)) signals.push("uses-resource-url");
  if (/\.[ ]*title\b/i.test(source)) signals.push("uses-resource-title");
  if (/\.[ ]*(?:featured_image|featured_media|media)\b/i.test(source)) {
    signals.push("uses-resource-media");
  }

  return {
    requiredParameters,
    hardContextDependencies: [...new Set(hardContextDependencies)],
    signals: [...new Set(signals)],
  };
}

function standaloneProductParameter(
  liquid: string,
): { name: string; staticArguments: Record<string, string>; score: number; signals: string[] } | null {
  const source = executableLiquidSource(liquid);
  const params = documentedParameters(liquid);
  if (params.length === 0) return null;

  let best: { name: string; score: number; signals: string[] } | null = null;

  for (const param of params) {
    const name = param.name;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const usage = (suffix: string) => new RegExp(`\\b${escaped}\\.${suffix}\\b`, "i").test(source);

    const hasUrl = usage("url");
    const hasTitle = usage("title");
    const hasMedia = usage("(?:featured_image|featured_media|media)");
    const hasId = usage("id");
    const hasAvailability = usage("available");
    const hasPrice = usage("(?:price|compare_at_price)");
    const resourceProductBranch =
      new RegExp(`\\bresource_type\\s*==\\s*['"]product['"]`, "i").test(source) &&
      name === "resource";

    // A price/helper snippet can receive a product but is not a product card.
    // Require navigational/card evidence: URL plus title/media, or the generic
    // resource snippet proving a product rendering branch from its own source.
    if (!(resourceProductBranch || (hasUrl && (hasTitle || hasMedia)))) continue;

    let score = 0;
    const signals: string[] = [];
    if (/product/i.test(name)) {
      score += 8;
      signals.push("documented-product-param");
    }
    if (resourceProductBranch) {
      score += 10;
      signals.push("resource-product-branch");
    }
    if (hasUrl) {
      score += 5;
      signals.push("product-url");
    }
    if (hasTitle) {
      score += 4;
      signals.push("product-title");
    }
    if (hasMedia) {
      score += 4;
      signals.push("product-media");
    }
    if (hasId) score += 1;
    if (hasAvailability) score += 1;
    if (hasPrice) score += 1;
    if (/\bclass\s*=\s*["'][^"']*card/i.test(source) || /<product-card\b/i.test(source)) {
      score += 4;
      signals.push("card-markup");
    }

    if (!best || score > best.score) best = { name, score, signals };
  }

  if (!best) return null;

  const staticArguments: Record<string, string> = {};
  if (
    best.name === "resource" &&
    /\bresource_type\s*==\s*['"]product['"]/i.test(source)
  ) {
    // This is source-derived capability, not a theme-name special case: the
    // snippet itself declares it can render a `resource` as a product.
    staticArguments.resource_type = "'product'";
  }

  return { ...best, staticArguments };
}

export function compileStandaloneSnippetRenderer(
  filename: string,
  liquid: string,
): RendererCandidate | null {
  if (!/^snippets\/[^/]+\.liquid$/i.test(filename)) return null;

  const productParam = standaloneProductParameter(liquid);
  if (!productParam) return null;

  const compatibility = analyzeSnippetCompatibility(liquid);
  if (compatibility.hardContextDependencies.length > 0) return null;

  const requiredWithoutProduct = compatibility.requiredParameters.filter(
    (name) => name !== productParam.name,
  );
  const unsupportedRequired = requiredWithoutProduct.filter(
    (name) => !(name in productParam.staticArguments),
  );
  if (unsupportedRequired.length > 0) return null;

  const snippet = filename.replace(/^snippets\//i, "").replace(/\.liquid$/i, "");
  const score = 18 + productParam.score;
  const profile: RendererProfile = {
    cardSnippet: snippet,
    productArgument: productParam.name,
    implicitProductVariable: null,
    invocationTag: "render",
    renderArguments: productParam.staticArguments,
    stylesheetAssets: extractStylesheetAssets(executableLiquidSource(liquid)),
    gridClass: null,
    itemClass: null,
    containerClass: null,
    gridTag: null,
    itemTag: null,
    containerTag: null,
    score,
    signals: [
      "standalone-snippet",
      ...productParam.signals,
      ...compatibility.signals,
    ],
  };

  return {
    profile,
    invocationIndex: 0,
    signature: [
      "standalone",
      snippet,
      productParam.name,
      Object.keys(productParam.staticArguments).sort().join(","),
    ].join(":"),
  };
}

function splitTopLevelArguments(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let depth = 0;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (quote && char === "\\") {
      current += char;
      escaped = true;
      continue;
    }

    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }

    if (char === "(" || char === "[" || char === "{") depth += 1;
    if (char === ")" || char === "]" || char === "}")
      depth = Math.max(0, depth - 1);

    if (char === "," && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim()) parts.push(current.trim());
  return parts;
}

function findTopLevelColon(input: string): number {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let depth = 0;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote && char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth += 1;
    if (char === ")" || char === "]" || char === "}")
      depth = Math.max(0, depth - 1);
    if (char === ":" && depth === 0) return index;
  }
  return -1;
}

function parseRenderArguments(input: string): Record<string, string> {
  const args: Record<string, string> = {};
  for (const part of splitTopLevelArguments(input)) {
    const colon = findTopLevelColon(part);
    if (colon <= 0) continue;
    const key = part.slice(0, colon).trim();
    const value = part.slice(colon + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !value) continue;
    args[key] = value;
  }
  return args;
}

type RenderObjectBinding = {
  mode: "with" | "for";
  expression: string;
  alias: string;
};

function parseRenderBinding(input: string): {
  binding: RenderObjectBinding | null;
  argumentsSource: string;
} {
  const trimmed = input.trim();
  const match = trimmed.match(
    /^(with|for)\s+(.+?)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*,\s*([\s\S]*))?$/i,
  );

  if (!match) {
    return { binding: null, argumentsSource: input };
  }

  return {
    binding: {
      mode: match[1].toLowerCase() as "with" | "for",
      expression: match[2].trim(),
      alias: match[3],
    },
    argumentsSource: match[4] ?? "",
  };
}

function productArgumentScore(key: string, rawValue: string): number {
  const normalizedKey = key.toLowerCase();
  const normalizedValue = rawValue.replace(/\s+/g, "").toLowerCase();
  const commonValues = new Set([
    "item",
    "product",
    "card_product",
    "product_item",
    "product_card_product",
    "search_result",
    "result",
  ]);
  const commonKeys = new Set([
    "product",
    "card_product",
    "product_item",
    "product_object",
    "product_card_product",
    "item",
  ]);

  if (commonValues.has(normalizedValue)) return 9;
  if (normalizedValue.endsWith(".product")) return 9;

  const simpleLiquidReference = /^[a-z_][a-z0-9_.]*$/i.test(normalizedValue);
  const looksLikeSetting =
    normalizedValue.startsWith("section.settings.") ||
    normalizedValue.startsWith("settings.");
  const presentationFlag = /^(show|hide|enable|disable|use|display)_/.test(
    normalizedKey,
  );

  if (commonKeys.has(normalizedKey) && simpleLiquidReference && !looksLikeSetting)
    return 8;

  if (
    normalizedKey.includes("product") &&
    !presentationFlag &&
    simpleLiquidReference &&
    !looksLikeSetting
  )
    return 5;

  return 0;
}

function nearestForLoop(source: string, invocationIndex: number): LoopContext {
  const start = Math.max(0, invocationIndex - 5_000);
  const text = source.slice(start, invocationIndex);
  const tagRegex = /\{%-?\s*(for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([^%]+?)|endfor)\s*-?%\}/gi;
  const stack: Array<{ variable: string; iterable: string }> = [];

  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(text)) !== null) {
    if (/^endfor$/i.test(match[1].trim())) {
      stack.pop();
      continue;
    }
    if (match[2] && match[3]) {
      stack.push({ variable: match[2], iterable: match[3].trim() });
    }
  }

  return stack.at(-1) ?? null;
}

function contextScore(
  source: string,
  invocationIndex: number,
  snippet: string,
  args: Record<string, string>,
  productArgument: string | null,
  loop: LoopContext,
) {
  let score = 0;
  const signals: string[] = [];
  // Snippet filenames are deliberately not used as product-card evidence.
  // Names such as `card-product`, `tile`, `resource-card`, or anything else are
  // theme conventions. Capability discovery must come from the Liquid data
  // flow/context and the target snippet source, not from naming guesses.
  void snippet;
  const context = source
    .slice(Math.max(0, invocationIndex - 2_500), invocationIndex + 1_500)
    .toLowerCase();
  if (productArgument) {
    score += 8;
    signals.push("explicit-product-argument");
  }
  if (context.includes("search.results") || context.includes("search.terms")) {
    score += 10;
    signals.push("search-context");
  }
  if (context.includes("collection.products")) {
    score += 8;
    signals.push("collection-products-context");
  }
  if (context.includes("recommendations.products")) {
    score += 4;
    signals.push("recommendations-context");
  }
  if (context.includes("predictive_search.resources.products")) {
    score += 4;
    signals.push("predictive-search-context");
  }
  if (loop) {
    score += 3;
    signals.push("product-loop-context");
    const iterable = loop.iterable.toLowerCase();
    if (iterable.includes("products") || iterable.includes("search.results")) {
      score += 5;
      signals.push("products-iterable");
    }

    if (productArgument) {
      const rawValue = args[productArgument]?.replace(/\s+/g, "");
      if (rawValue === loop.variable) {
        score += 8;
        signals.push("argument-matches-loop-variable");
      }
    }
  }

  const resourceType = args.resource_type?.trim();
  if (resourceType === "'product'" || resourceType === '"product"') {
    score += 8;
    signals.push("static-product-resource-type");
  }

  if ("show_vendor" in args) score += 1;
  if ("show_rating" in args) score += 1;
  if ("media_aspect_ratio" in args || "image_ratio" in args) score += 1;

  return { score, signals };
}

function emptyProfile(): RendererProfile {
  return {
    cardSnippet: null,
    productArgument: null,
    implicitProductVariable: null,
    invocationTag: "render",
    renderArguments: {},
    stylesheetAssets: [],
    gridClass: null,
    itemClass: null,
    containerClass: null,
    gridTag: null,
    itemTag: null,
    containerTag: null,
    score: 0,
    signals: [],
  };
}

export function compileSearchRendererCandidates(liquid: string): RendererCandidate[] {
  const source = executableLiquidSource(liquid);
  const stylesheetAssets = extractStylesheetAssets(source);
  const invocationRegex = /\{%-?\s*(render|include)\s+([\s\S]*?)%-?\}/gi;
  const candidates: RendererCandidate[] = [];

  let match: RegExpExecArray | null;
  while ((match = invocationRegex.exec(source)) !== null) {
    const invocationTag = match[1].toLowerCase() as LiquidInvocationTag;
    const body = match[2].trim();
    const snippetMatch = body.match(/^(['"])([^'"]+)\1/);
    if (!snippetMatch) continue;

    const snippet = snippetMatch[2];
    const rest = body.slice(snippetMatch[0].length).replace(/^\s*,\s*/, "");
    const parsedBinding = parseRenderBinding(rest);
    const args = parseRenderArguments(parsedBinding.argumentsSource);

    let productArgument: string | null = null;
    let productScore = 0;
    const loop = nearestForLoop(source, match.index);
    const productLikeLoop = Boolean(
      loop &&
        /(?:products|search\.results|recommendations\.products|predictive_search\.resources\.products)/i.test(
          loop.iterable,
        ),
    );

    // First trust exact data flow from a proven product/search loop. This is
    // stronger than argument names and supports arbitrary theme conventions
    // such as `{% for x in search.results %}` + `merchandise: x`.
    if (loop && productLikeLoop) {
      for (const [key, rawValue] of Object.entries(args)) {
        if (rawValue.replace(/\s+/g, "") === loop.variable) {
          productArgument = key;
          productScore = 10;
          break;
        }
      }
    }

    // Shopify also supports `render 'snippet' with object as alias` and
    // `render 'snippet' for array as alias`. The alias is explicit source
    // capability and can safely become the AI product argument.
    if (!productArgument && parsedBinding.binding) {
      const binding = parsedBinding.binding;
      const expression = binding.expression.replace(/\s+/g, "");
      const commonProductReference = /^(?:product|item|result|search_result|card_product|product_item)$/i.test(
        expression,
      );
      const productCollection = /(?:^|\.)(?:products|search\.results|recommendations\.products|predictive_search\.resources\.products)$/i.test(
        expression,
      );
      const matchesProductLoop = Boolean(
        loop && productLikeLoop && expression === loop.variable,
      );

      if (
        matchesProductLoop ||
        commonProductReference ||
        (binding.mode === "for" && productCollection)
      ) {
        productArgument = binding.alias;
        productScore = 9;
      }
    }

    // Generic resource renderers can declare the resource type explicitly.
    // This is source-derived capability, not a filename convention.
    if (!productArgument) {
      const resourceType = args.resource_type?.trim();
      if (
        (resourceType === "'product'" || resourceType === '"product"') &&
        typeof args.resource === "string"
      ) {
        productArgument = "resource";
        productScore = 9;
      }
    }

    // Last-resort argument inference is allowed only after exact loop/binding
    // proofs have been considered. The target snippet is validated later by
    // the renderer catalog before such a candidate can be used.
    if (!productArgument) {
      for (const [key, rawValue] of Object.entries(args)) {
        const score = productArgumentScore(key, rawValue);
        if (score > productScore) {
          productScore = score;
          productArgument = key;
        }
      }
    }

    const implicitProductVariable =
      invocationTag === "include" && !productArgument && loop && productLikeLoop
        ? loop.variable
        : null;

    if (!productArgument && !implicitProductVariable) continue;

    const context = contextScore(
      source,
      match.index,
      snippet,
      args,
      productArgument,
      loop,
    );

    let score = context.score + productScore;
    const signals = [...context.signals];
    if (parsedBinding.binding && productArgument === parsedBinding.binding.alias) {
      signals.push(`render-${parsedBinding.binding.mode}-binding`);
    }
    if (implicitProductVariable) {
      score += 7;
      signals.push("legacy-include-implicit-product");
    }

    // Require meaningful evidence that this invocation is a product card, not
    // merely a snippet receiving a product-shaped value for an unrelated job.
    if (score < 14) continue;

    const wrappers = extractWrappers(source, match.index);
    if (wrappers.gridClass) {
      score += 2;
      signals.push("theme-grid-wrapper");
    }
    if (wrappers.itemClass) {
      score += 2;
      signals.push("theme-item-wrapper");
    }

    const profile: RendererProfile = {
      cardSnippet: snippet,
      productArgument,
      implicitProductVariable,
      invocationTag,
      renderArguments: args,
      stylesheetAssets,
      ...wrappers,
      score,
      signals,
    };

    const signature = [
      invocationTag,
      snippet,
      productArgument ?? "",
      implicitProductVariable ?? "",
      Object.keys(args).sort().join(","),
    ].join(":");

    candidates.push({
      profile,
      invocationIndex: match.index,
      signature,
    });
  }

  const deduped = new Map<string, RendererCandidate>();
  for (const candidate of candidates) {
    const existing = deduped.get(candidate.signature);
    if (!existing || candidate.profile.score > existing.profile.score) {
      deduped.set(candidate.signature, candidate);
    }
  }

  return [...deduped.values()].sort(
    (a, b) => b.profile.score - a.profile.score || a.invocationIndex - b.invocationIndex,
  );
}

export function compileSearchRenderer(liquid: string): RendererProfile {
  return compileSearchRendererCandidates(liquid)[0]?.profile ?? emptyProfile();
}
