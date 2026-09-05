import type {
  ContainerTag,
  GridTag,
  ItemTag,
  RendererProfile,
} from "../theme/theme-compiler.server";

type ResolvedValue = string | number | boolean | null;
type ResolvedArguments = Record<string, ResolvedValue>;

type BuildRendererOptions = {
  handles: string[];
  profile: RendererProfile;
  resolvedArguments: ResolvedArguments;
};

function escapeLiquidString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function toLiquidValue(value: ResolvedValue): string {
  if (value === null) return "nil";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  return `'${escapeLiquidString(value)}'`;
}

function buildStylesheets(assets: string[]): string {
  return assets
    .map(
      (asset) =>
        `{{ '${escapeLiquidString(asset)}' | asset_url | stylesheet_tag }}`,
    )
    .join("\n");
}

function buildCardInvocation(
  profile: RendererProfile,
  resolvedArguments: ResolvedArguments,
  index: number,
): string {
  if (!profile.cardSnippet) {
    throw new Error("Theme Compiler không tìm thấy product card snippet");
  }

  if (!profile.productArgument && !profile.implicitProductVariable) {
    throw new Error("Theme Compiler không tìm thấy product binding");
  }

  const args: string[] = [];
  if (profile.productArgument) {
    args.push(`${profile.productArgument}: ai_product`);
  }

  for (const [key, value] of Object.entries(resolvedArguments)) {
    if (key === profile.productArgument) continue;

    if (profile.renderArguments[key] === "lazy_load") {
      args.push(`${key}: ${index > 1 ? "true" : "false"}`);
      continue;
    }

    args.push(`${key}: ${toLiquidValue(value)}`);
  }

  const tag = profile.invocationTag === "include" ? "include" : "render";
  const argsBlock = args.length ? `,\n      ${args.join(",\n      ")}` : "";

  return `{% ${tag} '${escapeLiquidString(profile.cardSnippet)}'${argsBlock}\n    %}`;
}

function safeGridTag(tag: GridTag | null): GridTag {
  return tag === "ul" || tag === "ol" || tag === "div" ? tag : "div";
}

function safeItemTag(tag: ItemTag | null, gridTag: GridTag): ItemTag {
  if (tag === "li" || tag === "div" || tag === "article") return tag;
  return gridTag === "ul" || gridTag === "ol" ? "li" : "div";
}

function safeContainerTag(tag: ContainerTag | null): ContainerTag {
  return tag === "section" || tag === "main" || tag === "div" ? tag : "div";
}

function classAttribute(className: string | null) {
  return className ? ` class="${className}"` : "";
}

export function buildThemeSearchLiquid({
  handles,
  profile,
  resolvedArguments,
}: BuildRendererOptions): string {
  // Shopify all_products exposes at most 20 unique handles in one Liquid
  // response. Keep the invariant inside the bridge as defense in depth.
  const safeHandles = [...new Set(handles.map((handle) => handle.trim()))]
    .filter(Boolean)
    .slice(0, 20);

  const stylesheets = buildStylesheets(profile.stylesheetAssets);
  const gridTag = safeGridTag(profile.gridTag);
  const itemTag = safeItemTag(profile.itemTag, gridTag);
  const containerTag = safeContainerTag(profile.containerTag);

  const cards = safeHandles
    .map((handle, index) => {
      const safeHandle = escapeLiquidString(handle);
      const implicitBinding = profile.implicitProductVariable
        ? `{% assign ${profile.implicitProductVariable} = ai_product %}`
        : "";
      const card = buildCardInvocation(profile, resolvedArguments, index);

      return `
        {% assign ai_product = all_products['${safeHandle}'] %}
        {% if ai_product %}
          ${implicitBinding}
          <${itemTag}${classAttribute(profile.itemClass)} data-ai-search-item="true">
            ${card}
          </${itemTag}>
        {% endif %}
      `;
    })
    .join("\n");

  const gridRole = gridTag === "ul" || gridTag === "ol" ? ' role="list"' : "";

  // The bridge emits only a structural shell. Product-card markup, product
  // argument names, invocation style, CSS assets, wrapper tags/classes and
  // resolved theme settings all come from the active theme source profile.
  // There is intentionally no app-owned product-card HTML or fallback grid CSS.
  return `
    ${stylesheets}

    <${containerTag}${classAttribute(profile.containerClass)} data-ai-search-results="true">
      <div data-ai-search-summary="true">
        <h1>Search results</h1>
        <p>${safeHandles.length} products</p>
      </div>

      <${gridTag}${classAttribute(profile.gridClass)}${gridRole} data-ai-search-grid="true">
        ${cards}
      </${gridTag}>
    </${containerTag}>
  `;
}
