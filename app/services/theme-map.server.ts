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
function analyzeSearchRenderPath(
  files: ThemeFileNode[],
  searchSections: string[],
) {
  const productGridCandidates =
    new Set<string>();
  const productCardCandidates =
    new Set<string>();
  const paginationCandidates =
    new Set<string>();
  for (
    const sectionFilename of searchSections
  ) {
    const sectionFile =
      getFile(
        files,
        sectionFilename,
      );
    if (!sectionFile) {
      continue;
    }
    const dependencies =
      extractLiquidDependencies(
        sectionFile.body?.content,
      );
    console.log(
      "[THEME MAP V3] Search Section dependencies:",
      {
        file:
          sectionFilename,
        dependencies,
      },
    );
    for (
      const dependency of dependencies
    ) {
      const resolved =
        resolveSnippetFilename(
          files,
          dependency,
        );
      if (!resolved) {
        continue;
      }
      if (
        isProductGridDependency(
          dependency,
          resolved,
        )
      ) {
        productGridCandidates.add(
          resolved,
        );
      }
      if (
        isPaginationDependency(
          dependency,
          resolved,
        )
      ) {
        paginationCandidates.add(
          resolved,
        );
      }
    }
  }
  if (
    productGridCandidates.size ===
    0
  ) {
    const priorities = [
      "snippets/product-grid.liquid",
      "snippets/product_grid.liquid",
    ];
    for (
      const filename of priorities
    ) {
      const file =
        findFileByName(
          files,
          filename,
        );
      if (file) {
        productGridCandidates.add(
          file.filename,
        );
        break;
      }
    }
  }
  for (
    const gridFilename of productGridCandidates
  ) {
    const gridFile =
      getFile(
        files,
        gridFilename,
      );
    if (!gridFile) {
      continue;
    }
    const dependencies =
      extractLiquidDependencies(
        gridFile.body?.content,
      );
    console.log(
      "[THEME MAP V3] Product Grid dependencies:",
      {
        file:
          gridFilename,
        dependencies,
      },
    );
    for (
      const dependency of dependencies
    ) {
      const resolved =
        resolveSnippetFilename(
          files,
          dependency,
        );
      if (!resolved) {
        continue;
      }
      if (
        isProductCardDependency(
          dependency,
          resolved,
        )
      ) {
        productCardCandidates.add(
          resolved,
        );
      }
      if (
        isPaginationDependency(
          dependency,
          resolved,
        )
      ) {
        paginationCandidates.add(
          resolved,
        );
      }
    }
  }
  if (
    productCardCandidates.size ===
    0
  ) {
    const priorities = [
      "snippets/product-card.liquid",
      "snippets/product_card.liquid",
    ];
    for (
      const filename of priorities
    ) {
      const file =
        findFileByName(
          files,
          filename,
        );
      if (file) {
        productCardCandidates.add(
          file.filename,
        );
        break;
      }
    }
  }
  if (
    paginationCandidates.size ===
    0
  ) {
    const priorities = [
      "snippets/pagination-controls.liquid",
      "snippets/pagination.liquid",
    ];
    for (
      const filename of priorities
    ) {
      const file =
        findFileByName(
          files,
          filename,
        );
      if (file) {
        paginationCandidates.add(
          file.filename,
        );
        break;
      }
    }
  }
  return {
    productGridCandidates:
      Array.from(
        productGridCandidates,
      ),
    productCardCandidates:
      Array.from(
        productCardCandidates,
      ),
    paginationCandidates:
      Array.from(
        paginationCandidates,
      ),
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
      ...renderPath,
      // The storefront runtime fetches Shopify's native search HTML and
      // reorders its theme-rendered product cards; it never hand-renders cards.
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

