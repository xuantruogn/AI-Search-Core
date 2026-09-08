// Theme Map / native HTML architecture adapted from the supplied ai-search app.
import { createHash } from "node:crypto";
import { getActiveTheme, getThemeFiles, type ActiveTheme } from "./theme/theme-reader.server";
import { readSearchThemeFiles, buildSearchThemeMap, searchMapProbeFiles, liquidDependencies } from "./theme/theme-source-graph.server";
export type AdminGraphqlClient = Parameters<typeof getActiveTheme>[0];
export type ThemeMap = {
  version: 3;
  fingerprint: string;
  sources: Array<{filename:string; digest:string|null}>;
  theme: {
    id: string;
    gid: string;
    updatedAt: string;
    versionKey: string;
    name: string;
    role: string;
    themeStoreId: number | null;
  };
  search: {
    searchTemplate: string | null;
    searchSections: string[];
    searchSectionTypes: string[];
    searchTemplateStructure: Array<{
      filename: string;
      sectionIds: string[];
      sectionTypes: string[];
    }>;
    productGridCandidates: string[];
    productCardCandidates: string[];
    paginationCandidates: string[];
    productCountCandidates: string[]; // <-- THÊM MỚI TẠI ĐÂY
    nativeSectionRendering: boolean;
  };
  generatedAt: string;
};
type ThemeFileNode = {
  filename: string;
  contentType?: string | null;
  body?: {
    content?: string | null;
  } | null;
};
function normalizeFilename(
  filename: string,
) {
  return filename
    .replace(/\\/g, "/")
    .toLowerCase();
}
function getFile(
  files: ThemeFileNode[],
  filename: string,
) {
  return files.find(
    (file) =>
      normalizeFilename(
        file.filename,
      ) ===
      normalizeFilename(
        filename,
      ),
  );
}
function findFileByName(
  files: ThemeFileNode[],
  filename: string,
) {
  const normalizedTarget =
    normalizeFilename(
      filename,
    );
  return files.find(
    (file) =>
      normalizeFilename(
        file.filename,
      ) === normalizedTarget,
  );
}
function extractLiquidDependencies(content?: string | null) {
  return liquidDependencies(content || "").dependencies.filter((name) => name.startsWith("snippets/")).map((name) => name.slice(9, -7));
}
function resolveSnippetFilename(
  files: ThemeFileNode[],
  dependency: string,
) {
  const normalizedDependency =
    dependency
      .trim()
      .replace(
        /^snippets\//i,
        "",
      )
      .replace(
        /\.liquid$/i,
        "",
      );
  const expectedFilename =
    `snippets/${normalizedDependency}.liquid`;
  const exact =
    findFileByName(
      files,
      expectedFilename,
    );
  if (exact) {
    return exact.filename;
  }
  const fallback =
    files.find((file) => {
      const normalized =
        normalizeFilename(
          file.filename,
        );
      return (
        normalized.startsWith(
          "snippets/",
        ) &&
        normalized.endsWith(
          `/${normalizedDependency}.liquid`,
        )
      );
    });
  return (
    fallback?.filename ||
    null
  );
}
function isProductGridDependency(
  dependency: string,
  resolvedFilename: string,
) {
  const value =
    `${dependency} ${resolvedFilename}`
      .toLowerCase();
  return (
    value.includes(
      "product-grid",
    ) ||
    value.includes(
      "product_grid",
    ) ||
    value.includes(
      "facets"
    ) || // THÊM MỚI: Quét cả file facets vì Dawn chứa Product Count ở đây
    value.includes(
      "productgrid",
    )
  );
}
function isProductCardDependency(
  dependency: string,
  resolvedFilename: string,
) {
  const value =
    `${dependency} ${resolvedFilename}`
      .toLowerCase();
  return (
    value.includes(
      "product-card",
    ) ||
    value.includes(
      "product_card",
    )
  );
}
function isPaginationDependency(
  dependency: string,
  resolvedFilename: string,
) {
  const value =
    `${dependency} ${resolvedFilename}`
      .toLowerCase();
  return (
    value.includes(
      "pagination",
    ) ||
    value.includes(
      "paginate",
    )
  );
}

//// Hàm nhận diện từ khóa
function isProductCountDependency(
  dependency: string,
  resolvedFilename: string,
) {
  const value = `${dependency} ${resolvedFilename}`.toLowerCase();
  return (
    value.includes("count") ||
    value.includes("results-header") ||
    value.includes("search-header") ||
    value.includes("facet-header") ||
    value.includes("header")
  );
}
/////
function analyzeSearchRenderPath(
  files: ThemeFileNode[],
  searchSections: string[],
) {
  const productGridCandidates = new Set<string>();
  const productCardCandidates = new Set<string>();
  const paginationCandidates = new Set<string>();
  const productCountCandidates = new Set<string>();

  // // Regex Level 1: Bắt Class/ID/Data-attribute chứa từ khóa liên quan đến Count
  // const countRegex = /(id|class|data-[\w-]+)=["']([^"']*(?:product-count|ProductCount|results-count|search-count|search__count|search-results__count|results-title|facet-count|filter-count|search-result-count)[^"']*)["']/gi;
  // Mở rộng Regex bắt thêm các class/id chứa item, items, product-item-count
  const countRegex = /(id|class|data-[\w-]+)=["']([^"']*(?:product-count|ProductCount|results-count|search-count|search__count|search-results__count|results-title|facet-count|filter-count|search-result-count|item-count|items-count|products-count|product-items)[^"']*)["']/gi;


  // =========================================================================
  // BƯỚC 1: QUÉT TOÀN BỘ FILE LIQUID
  // =========================================================================
  for (const file of files) {
    const content = file.body?.content || "";
    if (!content) continue;

    // --- LEVEL 1: QUÉT CLASS / ID / ATTRIBUTE ---
    const matches = content.match(countRegex);
    if (matches && matches.length > 0) {
      console.log(`[THEME MAP DEBUG] 🎯 [Level 1] Tìm thấy Class/ID Count trong: ${file.filename}`);
      matches.forEach((match) => {
        if (match.includes('id="')) {
          const id = match.split('id="')[1].split('"')[0].trim();
          if (id) productCountCandidates.add(`#${id}`);
        } else if (match.includes("id='")) {
          const id = match.split("id='")[1].split("'")[0].trim();
          if (id) productCountCandidates.add(`#${id}`);
        } else if (match.includes('class="')) {
          const cls = match.split('class="')[1].split('"')[0].split(' ')[0].trim();
          if (cls) productCountCandidates.add(`.${cls}`);
        } else if (match.includes("class='")) {
          const cls = match.split("class='")[1].split("'")[0].split(' ')[0].trim();
          if (cls) productCountCandidates.add(`.${cls}`);
        }
      });
    }

    // --- LEVEL 2: QUÉT THEME CỔ ĐIỂN (BIẾN LIQUID search.results_count) ---
    if (content.includes("search.results_count") || content.includes("search.results.size")) {
      console.log(`[THEME MAP DEBUG] 🎯 [Level 2] Tìm thấy biến Liquid search.results_count trong: ${file.filename}`);
      
      // Tìm thẻ HTML bọc biến (ví dụ: <h2>{{ search.results_count }} kết quả</h2>)
      const tagMatch = content.match(/<([a-z1-6]+)[^>]*>[^<]*\{\{\s*search\.(?:results_count|results\.size)/i);
      if (tagMatch && tagMatch[1]) {
        const tagName = tagMatch[1].toLowerCase();
        // Tránh bắt nhầm các thẻ vô hiệu như script, style
        if (!["script", "style", "option"].includes(tagName)) {
          console.log(`[THEME MAP DEBUG] └── Thẻ HTML bọc biến đếm: <${tagName}>`);
          productCountCandidates.add(`main ${tagName}`);
          productCountCandidates.add(`.search-template ${tagName}`);
          productCountCandidates.add(`template-search ${tagName}`);
        }
      }
    }
  }

  // =========================================================================
  // BƯỚC 2: PHÂN TÍCH DEPENDENCIES CỦA SECTION
  // =========================================================================
  for (const sectionFilename of searchSections) {
    const sectionFile = getFile(files, sectionFilename);
    if (!sectionFile) continue;

    const dependencies = extractLiquidDependencies(sectionFile.body?.content);
    console.log("[THEME MAP DEBUG] 📌 Phân tích Section File:", sectionFilename);
    console.log("[THEME MAP DEBUG] └── Liquid Dependencies tìm thấy:", dependencies);

    for (const dependency of dependencies) {
      const resolved = resolveSnippetFilename(files, dependency);
      if (!resolved) continue;

      if (isProductGridDependency(dependency, resolved)) productGridCandidates.add(resolved);
      if (isPaginationDependency(dependency, resolved)) paginationCandidates.add(resolved);
    }
  }

  if (productGridCandidates.size === 0) {
    const priorities = ["snippets/product-grid.liquid", "snippets/product_grid.liquid"];
    for (const filename of priorities) {
      const file = findFileByName(files, filename);
      if (file) {
        productGridCandidates.add(file.filename);
        break;
      }
    }
  }

  for (const gridFilename of productGridCandidates) {
    const gridFile = getFile(files, gridFilename);
    if (!gridFile) continue;

    const dependencies = extractLiquidDependencies(gridFile.body?.content);
    console.log("[THEME MAP V3] Product Grid dependencies:", { file: gridFilename, dependencies });

    for (const dependency of dependencies) {
      const resolved = resolveSnippetFilename(files, dependency);
      if (!resolved) continue;

      if (isProductCardDependency(dependency, resolved)) productCardCandidates.add(resolved);
      if (isPaginationDependency(dependency, resolved)) paginationCandidates.add(resolved);
    }
  }

  if (productCardCandidates.size === 0) {
    const priorities = ["snippets/product-card.liquid", "snippets/product_card.liquid"];
    for (const filename of priorities) {
      const file = findFileByName(files, filename);
      if (file) {
        productCardCandidates.add(file.filename);
        break;
      }
    }
  }

  if (paginationCandidates.size === 0) {
    const priorities = ["snippets/pagination-controls.liquid", "snippets/pagination.liquid"];
    for (const filename of priorities) {
      const file = findFileByName(files, filename);
      if (file) {
        paginationCandidates.add(file.filename);
        break;
      }
    }
  }

  console.log("==================================================");
  console.log("[THEME MAP DEBUG] 🎯 TỔNG HỢP CANDIDATES BẮT ĐƯỢC CHO THEME NÀY:");
  console.log("[THEME MAP DEBUG]", Array.from(productCountCandidates));
  console.log("==================================================");

  return {
    productGridCandidates: Array.from(productGridCandidates),
    productCardCandidates: Array.from(productCardCandidates),
    paginationCandidates: Array.from(paginationCandidates),
    productCountCandidates: Array.from(productCountCandidates),
  };
}

export function numericThemeId(id: string) {
  const match = id.match(/^(?:gid:\/\/shopify\/OnlineStoreTheme\/)?(\d+)$/);
  if (!match) throw new Error("INVALID_THEME_ID");
  return match[1];
}

export async function buildThemeMapForTheme(admin: AdminGraphqlClient, theme: ActiveTheme): Promise<ThemeMap> {
  if (theme.processing || theme.processingFailed) throw new Error("THEME_PROCESSING");
  const sourceFiles = await readSearchThemeFiles(admin, theme.id);
  const graph = buildSearchThemeMap(sourceFiles);
  const files: ThemeFileNode[] = [...sourceFiles.values()].map((file) => ({filename:file.filename, body:{content:file.content}}));
  const renderPath = analyzeSearchRenderPath(files, graph.sectionFiles.length ? graph.sectionFiles : [graph.template]);
  return {
    version: 3,
    fingerprint: graph.fingerprint,
    sources: searchMapProbeFiles(graph).map((filename) => ({filename, digest: sourceFiles.has(filename) ? createHash("sha256").update(sourceFiles.get(filename)!.content).digest("hex") : null})),
    theme: {id:numericThemeId(theme.id),gid:theme.id,name:theme.name,role:"main",themeStoreId:null,updatedAt:theme.updatedAt,versionKey:theme.versionKey},
    search: {
      searchTemplate:graph.template, searchSections:graph.sectionFiles,
      searchSectionTypes:graph.sectionFiles.map((name)=>name.slice(9,-7)),
      searchTemplateStructure:[{filename:graph.template,sectionIds:graph.sectionIds,sectionTypes:graph.sectionFiles.map((name)=>name.slice(9,-7))}],
      ...renderPath, // <-- ĐÃ BAO GỒM productCountCandidates TỪ analyzeSearchRenderPath
      nativeSectionRendering:true,
    },
    generatedAt:new Date().toISOString(),
  };
}

export async function isThemeMapCurrent(admin: AdminGraphqlClient, map: ThemeMap) {
  for (let offset=0; offset<map.sources.length; offset+=50) {
    const expected=map.sources.slice(offset,offset+50);
    const files=await getThemeFiles(admin,map.theme.gid,expected.map((file)=>file.filename));
    for (const file of expected) {
      const current=files.get(file.filename);
      const digest=current ? createHash("sha256").update(current.content).digest("hex") : null;
      if (digest!==file.digest) return false;
    }
  }
  return true;
}

export async function buildMainThemeMap(admin: AdminGraphqlClient) {
  return buildThemeMapForTheme(admin, await getActiveTheme(admin));
}

