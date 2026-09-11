import { createHash } from "node:crypto";
import { getActiveTheme, getThemeFiles, type ActiveTheme } from "./theme/theme-reader.server";
import { readSearchThemeFiles, buildSearchThemeMap, searchMapProbeFiles, liquidDependencies } from "./theme/theme-source-graph.server";

export type AdminGraphqlClient = Parameters<typeof getActiveTheme>[0];

export type ThemeMap = {
  version: 3;
  fingerprint: string;
  sources: Array<{filename: string; digest: string | null}>;
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
    productCountCandidates: string[];
    nativeSectionRendering: boolean;
  };
  generatedAt: string;
};

export type ClientThemeMapDTO = {
  v: 3;
  fp: string;
  grid: string[];
  card: string[];
  page: string[];
  cnt: string[];
};

// Hàm chuyển đổi từ filename/selector thô sang mảng CSS Selectors hợp lệ cho DOM
function transformCandidatesToCssSelectors(
  candidates: string[],
  files: ThemeFileNode[] = [],
  type: "grid" | "card" | "page"
): string[] {
  if (!candidates || candidates.length === 0) return [];

  const selectors = new Set<string>();

  for (const item of candidates) {
    if (item.startsWith(".") || item.startsWith("#") || item.includes(" ")) {
      // ❌ Không thêm các selector thuộc bộ lọc nếu thuộc loại grid
      if (type === "grid" && (item.includes("facet") || item.includes("filter"))) {
        continue;
      }
      selectors.add(item);
      continue;
    }

    const file = getFile(files, item);
    if (file && file.body?.content) {
      const content = file.body.content;

      const customTagMatches = content.match(/<([a-z0-9]+-[a-z0-9-]+)[^>]*>/gi);
      if (customTagMatches) {
        customTagMatches.forEach((tag) => {
          const tagName = tag.match(/<([a-z0-9]+-[a-z0-9-]+)/i)?.[1];
          if (tagName) selectors.add(tagName);
        });
      }

      const idMatches = content.match(/id=["']([^"']*(?:product-grid|SearchResults|search-results|grid|results)[^"']*)["']/gi);
      if (idMatches) {
        idMatches.forEach((m) => {
          const id = m.replace(/id=["']/i, "").replace(/["']$/, "").trim();
          if (id) selectors.add(`#${id}`);
        });
      }

      const classMatches = content.match(/class=["']([^"']*(?:product-grid|collection|grid|search-results|results-list|card)[^"']*)["']/gi);
      if (classMatches) {
        classMatches.forEach((m) => {
          const classStr = m.replace(/class=["']/i, "").replace(/["']$/, "").trim();
          const classes = classStr.split(/\s+/);
          classes.forEach((cls) => {
            if (cls && (cls.includes("grid") || cls.includes("product") || cls.includes("results") || cls.includes("collection") || cls.includes("card"))) {
              selectors.add(`.${cls}`);
            }
          });
        });
      }
    }

    const cleanName = item
      .replace(/^snippets\//i, "")
      .replace(/\.liquid$/i, "")
      .replace(/_/g, "-");

    if (type === "grid") {
      // ❌ Bỏ qua nếu tên snippet chứa facet/filter
      if (cleanName.includes("facet") || cleanName.includes("filter")) {
        continue;
      }
      selectors.add(`#${cleanName}`);
      selectors.add(`.${cleanName}`);
      selectors.add(`[id*="${cleanName}"]`);
      selectors.add(`[class*="${cleanName}"]`);
    } else if (type === "card") {
      selectors.add(`.${cleanName}`);
      selectors.add(`[class*="${cleanName}"]`);
    } else if (type === "page") {
      selectors.add(`.${cleanName}`);
      selectors.add(`[class*="${cleanName}"]`);
    }
  }

  return Array.from(selectors);
}

export function buildClientThemeMapDTO(
  fullMap: ThemeMap,
  files: ThemeFileNode[] = []
): ClientThemeMapDTO {
  const rawGrid = fullMap.search?.productGridCandidates || [];
  const rawCard = fullMap.search?.productCardCandidates || [];
  const rawPage = fullMap.search?.paginationCandidates || [];

  const gridCandidates = transformCandidatesToCssSelectors(rawGrid, files, "grid");
  const cardCandidates = transformCandidatesToCssSelectors(rawCard, files, "card");
  const pageCandidates = transformCandidatesToCssSelectors(rawPage, files, "page");

  // Lọc sạch lại mảng gridCandidates một lần nữa để chắc chắn 100% không dính facet
  const cleanGrid = gridCandidates.filter(
    (s) => !s.includes("facet") && !s.includes("filter")
  );

  const dto: ClientThemeMapDTO = {
    v: 3,
    fp: fullMap.fingerprint || "",
    // 💡 MỞ RỘNG MẢNG FALLBACK DÀNH CHO DÒNG THEME DỊ BIỆT
    grid: cleanGrid.length > 0 ? cleanGrid : [
      "#product-grid", 
      ".product-grid", 
      ".product-grid-container", 
      ".grid-products", 
      ".products-grid", 
      "[data-products-grid]",
      ".main-search__results",
      "#SearchResults",
      ".collection__grid"
    ],
    card: cardCandidates.length > 0 ? cardCandidates : [".card-wrapper", ".product-card", ".grid__item", ".product-item"],
    page: pageCandidates.length > 0 ? pageCandidates : [".pagination-wrapper", ".pagination", ".paginate", "nav[role='navigation']"],
    cnt: fullMap.search?.productCountCandidates || [".product-count", "#ProductCount", ".results-count"],
  };

  // 📦 LOG DỮ LIỆU ĐÃ CHUYỂN ĐỔI SANG DTO
  console.log("\n📦 ================== [TRANSFORMED CSS SELECTORS DTO] ==================");
  console.log(`Fingerprint (fp): ${dto.fp}`);
  console.log("CSS Selectors cho Grid (grid) :", dto.grid);
  console.log("CSS Selectors cho Card (card) :", dto.card);
  console.log("CSS Selectors cho Page (page) :", dto.page);
  console.log("CSS Selectors cho Count (cnt):", dto.cnt);
  console.log("======================================================================\n");

  return dto;
}


type ThemeFileNode = {
  filename: string;
  contentType?: string | null;
  body?: {
    content?: string | null;
  } | null;
};

function normalizeFilename(filename: string) {
  return filename.replace(/\\/g, "/").toLowerCase();
}

function getFile(files: ThemeFileNode[], filename: string) {
  return files.find(
    (file) => normalizeFilename(file.filename) === normalizeFilename(filename),
  );
}

function findFileByName(files: ThemeFileNode[], filename: string) {
  const normalizedTarget = normalizeFilename(filename);
  return files.find(
    (file) => normalizeFilename(file.filename) === normalizedTarget,
  );
}

function extractLiquidDependencies(content?: string | null) {
  return liquidDependencies(content || "").dependencies
    .filter((name) => name.startsWith("snippets/"))
    .map((name) => name.slice(9, -7));
}

function resolveSnippetFilename(files: ThemeFileNode[], dependency: string) {
  const normalizedDependency = dependency
    .trim()
    .replace(/^snippets\//i, "")
    .replace(/\.liquid$/i, "");
  const expectedFilename = `snippets/${normalizedDependency}.liquid`;
  const exact = findFileByName(files, expectedFilename);
  if (exact) {
    return exact.filename;
  }
  const fallback = files.find((file) => {
    const normalized = normalizeFilename(file.filename);
    return (
      normalized.startsWith("snippets/") &&
      normalized.endsWith(`/${normalizedDependency}.liquid`)
    );
  });
  return fallback?.filename || null;
}

function isProductGridDependency(dependency: string, resolvedFilename: string) {
  const value = `${dependency} ${resolvedFilename}`.toLowerCase();

  // ❌ LOẠI TRỪ KHỎI GRID: Không bao giờ coi snippets bộ lọc/sắp xếp là Product Grid
  if (value.includes("facets") || value.includes("filter") || value.includes("sorting")) {
    return false;
  }

  return (
    value.includes("product-grid") ||
    value.includes("product_grid") ||
    value.includes("productgrid") ||
    value.includes("main-search")
  );
}

function isProductCardDependency(dependency: string, resolvedFilename: string) {
  const value = `${dependency} ${resolvedFilename}`.toLowerCase();
  return value.includes("product-card") || value.includes("product_card");
}

function isPaginationDependency(dependency: string, resolvedFilename: string) {
  const value = `${dependency} ${resolvedFilename}`.toLowerCase();
  return value.includes("pagination") || value.includes("paginate");
}

function analyzeSearchRenderPath(
  files: ThemeFileNode[],
  searchSections: string[],
) {
  const productGridCandidates = new Set<string>();
  const productCardCandidates = new Set<string>();
  const paginationCandidates = new Set<string>();
  const productCountCandidates = new Set<string>();

  const countRegex = /(id|class|data-[\w-]+)=["']([^"']*(?:product-count|ProductCount|results-count|search-count|search__count|search-results__count|results-title|facet-count|filter-count|search-result-count|item-count|items-count|products-count|product-items)[^"']*)["']/gi;

  for (const file of files) {
    const content = file.body?.content || "";
    if (!content) continue;

    // 1. Quét Product Count
    const matches = content.match(countRegex);
    if (matches && matches.length > 0) {
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

    if (content.includes("search.results_count") || content.includes("search.results.size")) {
      const tagMatch = content.match(/<([a-z1-6]+)[^>]*>[^<]*\{\{\s*search\.(?:results_count|results\.size)/i);
      if (tagMatch && tagMatch[1]) {
        const tagName = tagMatch[1].toLowerCase();
        if (!["script", "style", "option"].includes(tagName)) {
          productCountCandidates.add(`main ${tagName}`);
          productCountCandidates.add(`.search-template ${tagName}`);
          productCountCandidates.add(`template-search ${tagName}`);
        }
      }
    }

    // 2. BỔ SUNG QUÉT TRỰC TIẾP GRID & CARD TỪ FILE LIQUID (CHO THEME DAWN/MAIN-SEARCH)
    if (content.includes('id="ProductGridContainer"') || content.includes('product-grid-container')) {
      productGridCandidates.add('.product-grid-container');
    }
    if (content.includes('id="product-grid"')) {
      productGridCandidates.add('#product-grid');
    }
    if (content.includes('class="grid product-grid') || content.includes('product-grid')) {
      productGridCandidates.add('.product-grid');
    }

    if (
      content.includes("render 'card-product'") || 
      content.includes('render "card-product"') || 
      content.includes('card-product')
    ) {
      productCardCandidates.add('.grid__item');
      productCardCandidates.add('.card-wrapper');
      productCardCandidates.add('.product-card');
    }
  }

  // 3. Phân tích Dependencies lồng nhúng (Snippet Dependencies)
  for (const sectionFilename of searchSections) {
    const sectionFile = getFile(files, sectionFilename);
    if (!sectionFile) continue;

    const dependencies = extractLiquidDependencies(sectionFile.body?.content);

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

  // 4. Khai báo DUY NHẤT một biến result
  const result = {
    productGridCandidates: Array.from(productGridCandidates),
    productCardCandidates: Array.from(productCardCandidates),
    paginationCandidates: Array.from(paginationCandidates),
    productCountCandidates: Array.from(productCountCandidates),
  };

  // 🔍 LOG CÁC ỨNG VIÊN TÌM THẤY TỪ FILE LIQUID
  console.log("\n🔍 ================== [ANALYZED LIQUID CANDIDATES] ==================");
  console.log("1. Product Grid Candidates :", result.productGridCandidates);
  console.log("2. Product Card Candidates :", result.productCardCandidates);
  console.log("3. Pagination Candidates   :", result.paginationCandidates);
  console.log("4. Product Count Candidates:", result.productCountCandidates);
  console.log("=====================================================================\n");

  return result;
}

export function numericThemeId(id: string) {
  const match = id.match(/^(?:gid:\/\/shopify\/OnlineStoreTheme\/)?(\d+)$/);
  if (!match) throw new Error("INVALID_THEME_ID");
  return match[1];
}

export async function buildThemeMapForTheme(admin: AdminGraphqlClient, theme: ActiveTheme): Promise<ThemeMap> {
  if (!theme || theme.processing || theme.processingFailed) throw new Error("THEME_PROCESSING");
  
  const sourceFiles = await readSearchThemeFiles(admin, theme.id);
  
  // 🔴 THÊM LOG NÀY ĐỂ XEM DẠNG TÓM TẮT TOÀN BỘ FILE THEME ĐÃ TẢI VỀ:
  console.log("\n📁 ================== [TẤT CẢ FILE THEME ĐÃ TẢI TỪ SHOPIFY] ==================");
  console.log(`Tổng số file tải được: ${sourceFiles.size}`);
  console.log("Danh sách file:", Array.from(sourceFiles.keys()));
  console.log("============================================================================\n");

  console.log("\n📄 ================== [NỘI DUNG FILE TEMPLATES/SEARCH.JSON] ==================");
  console.log("\n📄 [TEMPLATES/SEARCH.JSON]:\n", sourceFiles.get("templates/search.json")?.content || "❌ KHÔNG TÌM THẤY FILE templates/search.json");
  console.log("============================================================================\n");

  console.log("\n📄 ================== [NỘI DUNG FILE sections/main-search.liquid] ==================");
  console.log("\n📄 [TEMPLATES/SEARCH.JSON]:\n", sourceFiles.get("sections/main-search.liquid")?.content || "❌ KHÔNG TÌM THẤY FILE sections/main-search.liquid");
  console.log("============================================================================\n");

  const graph = buildSearchThemeMap(sourceFiles);
  const files: ThemeFileNode[] = [...sourceFiles.values()].map((file) => ({filename: file.filename, body: {content: file.content}}));
  const renderPath = analyzeSearchRenderPath(files, graph.sectionFiles.length ? graph.sectionFiles : [graph.template]);
  
  return {
    version: 3,
    fingerprint: graph.fingerprint,
    sources: searchMapProbeFiles(graph).map((filename) => ({
      filename,
      digest: sourceFiles.has(filename) ? createHash("sha256").update(sourceFiles.get(filename)!.content).digest("hex") : null
    })),
    theme: {
      id: numericThemeId(theme.id),
      gid: theme.id,
      name: theme.name ?? "Main Theme",
      role: "main",
      themeStoreId: null,
      updatedAt: theme.updatedAt ?? new Date().toISOString(),
      versionKey: (theme as any)?.versionKey ?? "",
    },
    search: {
      searchTemplate: graph.template,
      searchSections: graph.sectionFiles,
      searchSectionTypes: graph.sectionFiles.map((name) => name.slice(9, -7)),
      searchTemplateStructure: [{
        filename: graph.template,
        sectionIds: graph.sectionIds,
        sectionTypes: graph.sectionFiles.map((name) => name.slice(9, -7))
      }],
      ...renderPath,
      nativeSectionRendering: true,
    },
    generatedAt: new Date().toISOString(),
  };
}

export async function isThemeMapCurrent(admin: AdminGraphqlClient, map: ThemeMap) {
  for (let offset = 0; offset < map.sources.length; offset += 50) {
    const expected = map.sources.slice(offset, offset + 50);
    const files = await getThemeFiles(admin, map.theme.gid, expected.map((file) => file.filename));
    for (const file of expected) {
      const current = files.get(file.filename);
      const digest = current ? createHash("sha256").update(current.content).digest("hex") : null;
      if (digest !== file.digest) return false;
    }
  }
  return true;
}

export async function buildMainThemeMap(admin: AdminGraphqlClient) {
  return buildThemeMapForTheme(admin, await getActiveTheme(admin));
}