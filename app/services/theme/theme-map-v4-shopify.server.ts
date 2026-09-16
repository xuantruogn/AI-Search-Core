import { createHash } from "node:crypto";

import {
  getActiveTheme,
  getThemeFiles,
  type ActiveTheme,
} from "./theme-reader.server";

import {
  compileThemeMapV4,
} from "./theme-map-v4.compiler.server";

import {
  scanLiquidDependencies,
  type ThemeSourceFile,
} from "./theme-dependency-graph.server";

import type {
  ThemeArgumentValue,
  ThemeMapV4,
  ThemeMapV4SearchIdentity,
} from "./theme-map-v4.types";

import type {
  ThemeSettingResolver,
} from "./theme-context-analyzer.server";

export type AdminGraphqlClient =
  Parameters<typeof getActiveTheme>[0];

interface SearchJsonSection {
  type?: unknown;
  settings?: unknown;
  blocks?: unknown;
  block_order?: unknown;
  disabled?: unknown;
}

interface SearchJsonBlockInstance {
  id: string;

  type: string;

  name?: string;

  static: boolean;

  settings:
    Record<string, unknown>;

  blocks:
    SearchJsonBlockInstance[];

  blockOrder:
    string[];
}

interface SearchJsonSectionInstance {
  key: string;

  type: string;

  settings:
    Record<string, unknown>;

  blocks:
    SearchJsonBlockInstance[];

  blockOrder:
    string[];
}

function normalizeFilename(
  filename: string,
): string {
  return filename
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .toLowerCase();
}

function numericThemeId(
  id: string,
): string {
  return (
    id.match(
      /^(?:gid:\/\/shopify\/OnlineStoreTheme\/)?(\d+)$/,
    )?.[1] ??
    id
  );
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

function toThemeSourceFile(
  file: {
    filename: string;
    content: string;
  },
): ThemeSourceFile {
  return {
    filename:
      file.filename,

    content:
      file.content,

    checksum:
      sha256(
        file.content,
      ),
  };
}

function findSourceFile(
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

function mergeSourceFiles(
  current: ThemeSourceFile[],
  incoming: ThemeSourceFile[],
): ThemeSourceFile[] {
  const map =
    new Map<
      string,
      ThemeSourceFile
    >();

  for (
    const file
    of current
  ) {
    map.set(
      normalizeFilename(
        file.filename,
      ),
      file,
    );
  }

  for (
    const file
    of incoming
  ) {
    map.set(
      normalizeFilename(
        file.filename,
      ),
      file,
    );
  }

  return [
    ...map.values(),
  ];
}

async function fetchThemeSourceFiles(
  admin: AdminGraphqlClient,
  themeId: string,
  filenames: string[],
): Promise<ThemeSourceFile[]> {
  const unique =
    [
      ...new Set(
        filenames
          .map(
            (filename) =>
              filename.trim(),
          )
          .filter(Boolean),
      ),
    ];

  if (
    unique.length === 0
  ) {
    return [];
  }

  const result:
    ThemeSourceFile[] = [];

  /**
   * Giữ batch nhỏ.
   *
   * Existing theme-reader đang hỗ trợ getThemeFiles(...)
   * theo mảng filename.
   */
  for (
    let offset = 0;
    offset < unique.length;
    offset += 50
  ) {
    const batch =
      unique.slice(
        offset,
        offset + 50,
      );

    const files =
      await getThemeFiles(
        admin,
        themeId,
        batch,
      );

    for (
      const file
      of files.values()
    ) {
      result.push(
        toThemeSourceFile({
          filename:
            file.filename,

          content:
            file.content,
        }),
      );
    }
  }

  return result;
}

function stripJsonComments(
  source: string,
): string {
  const input =
    source.charCodeAt(0) === 0xfeff
      ? source.slice(1)
      : source;

  let output =
    "";

  let inString =
    false;

  let escaped =
    false;

  let inLineComment =
    false;

  let inBlockComment =
    false;

  for (
    let index = 0;
    index < input.length;
    index += 1
  ) {
    const char =
      input[index];

    const next =
      input[index + 1] ??
      "";

    if (
      inLineComment
    ) {
      if (
        char === "\n" ||
        char === "\r"
      ) {
        inLineComment =
          false;

        output +=
          char;
      } else {
        output +=
          " ";
      }

      continue;
    }

    if (
      inBlockComment
    ) {
      if (
        char === "*" &&
        next === "/"
      ) {
        output +=
          "  ";

        index +=
          1;

        inBlockComment =
          false;
      } else if (
        char === "\n" ||
        char === "\r"
      ) {
        output +=
          char;
      } else {
        output +=
          " ";
      }

      continue;
    }

    if (
      inString
    ) {
      output +=
        char;

      if (
        escaped
      ) {
        escaped =
          false;

        continue;
      }

      if (
        char === "\\"
      ) {
        escaped =
          true;

        continue;
      }

      if (
        char === '"'
      ) {
        inString =
          false;
      }

      continue;
    }

    if (
      char === '"'
    ) {
      inString =
        true;

      output +=
        char;

      continue;
    }

    if (
      char === "/" &&
      next === "/"
    ) {
      output +=
        "  ";

      index +=
        1;

      inLineComment =
        true;

      continue;
    }

    if (
      char === "/" &&
      next === "*"
    ) {
      output +=
        "  ";

      index +=
        1;

      inBlockComment =
        true;

      continue;
    }

    output +=
      char;
  }

  return output;
}

function parseJson(
  source: string,
): unknown {
  try {
    return JSON.parse(
      stripJsonComments(
        source,
      ),
    );
  } catch {
    return null;
  }
}

function asRecord(
  value: unknown,
): Record<
  string,
  unknown
> | null {
  if (
    !value ||
    typeof value !==
      "object" ||
    Array.isArray(
      value,
    )
  ) {
    return null;
  }

  return value as Record<
    string,
    unknown
  >;
}

function stringArray(
  value: unknown,
): string[] {
  if (
    !Array.isArray(
      value,
    )
  ) {
    return [];
  }

  return value.filter(
    (
      item,
    ): item is string =>
      typeof item ===
        "string" &&
      item.trim().length >
        0,
  );
}

function parseSearchJsonBlocks(
  value: unknown,
): SearchJsonBlockInstance[] {
  const rawBlocks =
    asRecord(
      value,
    );

  if (!rawBlocks) {
    return [];
  }

  const result:
    SearchJsonBlockInstance[] =
      [];

  for (
    const [
      id,
      rawBlock,
    ]
    of Object.entries(
      rawBlocks,
    )
  ) {
    const block =
      asRecord(
        rawBlock,
      );

    if (!block) {
      continue;
    }

    if (
      typeof block.type !==
        "string" ||
      !block.type.trim()
    ) {
      continue;
    }

    const name =
      typeof block.name ===
        "string" &&
      block.name.trim()
        ? block.name.trim()
        : undefined;

    result.push({
      id,

      type:
        block.type.trim(),

      ...(name
        ? {
            name,
          }
        : {}),

      static:
        block.static ===
        true,

      settings:
        asRecord(
          block.settings,
        ) ?? {},

      blocks:
        parseSearchJsonBlocks(
          block.blocks,
        ),

      blockOrder:
        stringArray(
          block.block_order,
        ),
    });
  }

  return result;
}

function localThemeBlockFilename(
  blockType: string,
): string | null {
  const type =
    blockType.trim();

  /**
   * Chỉ local Theme Block.
   *
   * Ví dụ:
   *
   * _product-card
   * product-title
   * price
   * swatches
   *
   * Không biến app block / remote identifier
   * thành filename giả.
   */
  if (
    !/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(
      type,
    )
  ) {
    return null;
  }

  return `blocks/${type}.liquid`;
}

function collectThemeBlockSourceFiles(
  blocks:
    SearchJsonBlockInstance[],
): string[] {
  const filenames =
    new Set<string>();

  const visit = (
    nodes:
      SearchJsonBlockInstance[],
  ) => {
    for (
      const block
      of nodes
    ) {
      const filename =
        localThemeBlockFilename(
          block.type,
        );

      if (filename) {
        filenames.add(
          filename,
        );
      }

      visit(
        block.blocks,
      );
    }
  };

  visit(
    blocks,
  );

  return [
    ...filenames,
  ];
}

function countThemeBlocks(
  blocks:
    SearchJsonBlockInstance[],
): number {
  let total = 0;

  const visit = (
    nodes:
      SearchJsonBlockInstance[],
  ) => {
    for (
      const block
      of nodes
    ) {
      total += 1;

      visit(
        block.blocks,
      );
    }
  };

  visit(
    blocks,
  );

  return total;
}

function scalarSetting(
  value: unknown,
): ThemeArgumentValue | undefined {
  if (
    value === null
  ) {
    return null;
  }

  if (
    typeof value ===
      "string" ||
    typeof value ===
      "boolean"
  ) {
    return value;
  }

  if (
    typeof value ===
      "number" &&
    Number.isFinite(
      value,
    )
  ) {
    return value;
  }

  return undefined;
}

function parseSearchJsonSections(
  source: string,
): SearchJsonSectionInstance[] {
  const parsed =
    parseJson(
      source,
    );

  const root =
    asRecord(
      parsed,
    );

  if (!root) {
    return [];
  }

  const rawSections =
    asRecord(
      root.sections,
    );

  if (!rawSections) {
    return [];
  }

  const order =
    stringArray(
      root.order,
    );

  const orderedKeys = [
    ...order,

    ...Object.keys(
      rawSections,
    ).filter(
      (key) =>
        !order.includes(
          key,
        ),
    ),
  ];

  const result:
    SearchJsonSectionInstance[] =
      [];

  for (
    const key
    of orderedKeys
  ) {
    const rawSection =
      rawSections[
        key
      ] as
        | SearchJsonSection
        | undefined;

    const section =
      asRecord(
        rawSection,
      );

    if (!section) {
      continue;
    }

    if (
      section.disabled ===
      true
    ) {
      continue;
    }

    if (
      typeof section.type !==
        "string" ||
      !section.type.trim()
    ) {
      continue;
    }

    result.push({
      key,

      type:
        section.type.trim(),

      settings:
        asRecord(
          section.settings,
        ) ?? {},

      blocks:
        parseSearchJsonBlocks(
          section.blocks,
        ),

      blockOrder:
        stringArray(
          section.block_order,
        ),
    });
  }

  return result;
}

function sectionFilename(
  sectionType: string,
): string {
  return `sections/${sectionType}.liquid`;
}

/**
 * Legacy templates/search.liquid có thể gọi:
 *
 * {% section 'whatever' %}
 *
 * Chỉ lấy literal section name.
 * Dynamic section dependency không được đoán.
 */
function scanStaticSectionDependencies(
  source: string,
): string[] {
  const result =
    new Set<string>();

  const regex =
    /\{%-?\s*section\s+(['"])(.*?)\1\s*-?%\}/gi;

  let match:
    RegExpExecArray | null;

  while (
    (
      match =
        regex.exec(
          source,
        )
    ) != null
  ) {
    const name =
      match[2]
        .trim()
        .replace(
          /^sections\//i,
          "",
        )
        .replace(
          /\.liquid$/i,
          "",
        );

    if (name) {
      result.add(
        sectionFilename(
          name,
        ),
      );
    }
  }

  return [
    ...result,
  ];
}

/**
 * Fetch snippet dependency recursively.
 *
 * Quan trọng:
 *
 * - không scan toàn theme
 * - không đoán card-product
 * - chỉ follow render/include literal thực tế
 */
async function loadLiquidDependencies(
  admin: AdminGraphqlClient,
  themeId: string,
  seedFiles: ThemeSourceFile[],
): Promise<ThemeSourceFile[]> {
  let files =
    [...seedFiles];

  const scanned =
    new Set<string>();

  for (;;) {
    const needed =
      new Set<string>();

    for (
      const file
      of files
    ) {
      const normalized =
        normalizeFilename(
          file.filename,
        );

      if (
        scanned.has(
          normalized,
        )
      ) {
        continue;
      }

      if (
        !normalized.endsWith(
          ".liquid",
        )
      ) {
        scanned.add(
          normalized,
        );

        continue;
      }

      scanned.add(
        normalized,
      );

      const scan =
        scanLiquidDependencies(
          file.content,
        );

      /**
       * Dynamic render:
       *
       * {% render renderer_name %}
       *
       * Compiler sẽ reject candidate tương ứng.
       * Không đoán file ở đây.
       */
      for (
        const dependency
        of scan.dependencies
      ) {
        if (
          !findSourceFile(
            files,
            dependency,
          )
        ) {
          needed.add(
            dependency,
          );
        }
      }
    }

    if (
      needed.size === 0
    ) {
      break;
    }

    const loaded =
      await fetchThemeSourceFiles(
        admin,
        themeId,
        [...needed],
      );

    if (
      loaded.length === 0
    ) {
      /**
       * Dependency không tồn tại.
       * Compiler sẽ giữ MISSING diagnostics.
       */
      break;
    }

    const before =
      files.length;

    files =
      mergeSourceFiles(
        files,
        loaded,
      );

    if (
      files.length ===
      before
    ) {
      break;
    }
  }

  return files;
}

function readGlobalSettings(
  settingsData:
    ThemeSourceFile | undefined,
): Record<
  string,
  unknown
> {
  if (!settingsData) {
    return {};
  }

  const parsed =
    parseJson(
      settingsData.content,
    );

  const root =
    asRecord(
      parsed,
    );

  if (!root) {
    return {};
  }

  /**
   * Shopify settings_data.json thường:
   *
   * {
   *   "current": {
   *     "some_setting": ...
   *   }
   * }
   */
  const current =
    asRecord(
      root.current,
    );

  return (
    current ??
    {}
  );
}

function settingNameFromExpression(
  expression: string,
  prefix: string,
): string | null {
  const value =
    expression.trim();

  if (
    !value.startsWith(
      prefix,
    )
  ) {
    return null;
  }

  const rest =
    value.slice(
      prefix.length,
    );

  /**
   * Chỉ resolve direct property:
   *
   * section.settings.show_vendor
   *
   * Không tự suy luận:
   *
   * section.settings.foo.bar
   */
  if (
    !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(
      rest,
    )
  ) {
    return null;
  }

  return rest;
}

function createSettingResolver(
  sectionSettings:
    Record<string, unknown>,

  globalSettings:
    Record<string, unknown>,
): ThemeSettingResolver {
  return {
    resolveSectionSetting(
      expression,
    ) {
      const name =
        settingNameFromExpression(
          expression,
          "section.settings.",
        );

      if (!name) {
        return undefined;
      }

      return scalarSetting(
        sectionSettings[
          name
        ],
      );
    },

    resolveGlobalSetting(
      expression,
    ) {
      const name =
        settingNameFromExpression(
          expression,
          "settings.",
        );

      if (!name) {
        return undefined;
      }

      return scalarSetting(
        globalSettings[
          name
        ],
      );
    },
  };
}

function scoreCompiledMap(
  map: ThemeMapV4,
): number {
  const eligible =
    map.rendererCandidates
      .filter(
        (candidate) =>
          candidate.status ===
            "ELIGIBLE" &&
          candidate.mount != null,
      );

  if (
    eligible.length === 0
  ) {
    /**
     * Unsupported map vẫn có giá trị diagnostics.
     */
    return (
      map.rendererCandidates
        .length
    );
  }

  return (
    10_000 +
    eligible[0].score
  );
}

function bestCompiledMap(
  maps: ThemeMapV4[],
): ThemeMapV4 | null {
  if (
    maps.length === 0
  ) {
    return null;
  }

  return [...maps].sort(
    (
      left,
      right,
    ) =>
      scoreCompiledMap(
        right,
      ) -
      scoreCompiledMap(
        left,
      ),
  )[0];
}

function unsupportedMap(
  theme: ActiveTheme,
  search:
    ThemeMapV4SearchIdentity,
  reason: string,
): ThemeMapV4 {
  return {
    version: 4,

    theme: {
      id:
        numericThemeId(
          theme.id,
        ),

      name:
        theme.name ??
        "Main Theme",
    },

    search,

    rendererCandidates:
      [],

    dependencies:
      [],

    fingerprint:
      sha256(
        [
          numericThemeId(
            theme.id,
          ),

          search.templateFile,

          reason,
        ].join(":"),
      ),

    pageSize:
      20,

    status:
      "UNSUPPORTED",

    unsupportedReason:
      reason,
  };
}

/**
 * JSON template flow:
 *
 * templates/search.json
 *      ↓
 * sections[key].type
 *      ↓
 * sections/<type>.liquid
 *      ↓
 * dependencies
 *      ↓
 * compileThemeMapV4()
 */
async function compileJsonSearchTemplate(
  admin: AdminGraphqlClient,
  theme: ActiveTheme,
  template:
    ThemeSourceFile,
  initialFiles:
    ThemeSourceFile[],
  globalSettings:
    Record<string, unknown>,
): Promise<ThemeMapV4> {
  const sections =
    parseSearchJsonSections(
      template.content,
    );

  if (
    sections.length === 0
  ) {
    return unsupportedMap(
      theme,
      {
        templateFile:
          template.filename,

        templateType:
          "JSON",
      },

      "SEARCH_JSON_HAS_NO_STATIC_SECTIONS",
    );
  }

  const sectionFiles =
    await fetchThemeSourceFiles(
      admin,
      theme.id,
      sections.map(
        (section) =>
          sectionFilename(
            section.type,
          ),
      ),
    );

  /**
   * Theme Blocks được xác định trực tiếp từ
   * templates/search.json.
   *
   * Không đoán tên renderer.
   * Không scan toàn theme.
   *
   * Ví dụ Ritual:
   *
   * _product-card
   * _product-card-gallery
   * _product-card-group
   * product-title
   * price
   * swatches
   */
  const themeBlockSourceFiles =
    [
      ...new Set(
        sections.flatMap(
          (section) =>
            collectThemeBlockSourceFiles(
              section.blocks,
            ),
        ),
      ),
    ];

  const blockFiles =
    await fetchThemeSourceFiles(
      admin,
      theme.id,
      themeBlockSourceFiles,
    );

  let files =
    mergeSourceFiles(
      mergeSourceFiles(
        initialFiles,
        sectionFiles,
      ),
      blockFiles,
    );

  console.log(
    "[AI Search][Theme Map V4] JSON Theme Block graph loaded:",
    {
      sections:
        sections.map(
          (section) => ({
            key:
              section.key,

            type:
              section.type,

            blocks:
              countThemeBlocks(
                section.blocks,
              ),

            blockSourceFiles:
              collectThemeBlockSourceFiles(
                section.blocks,
              ),
          }),
        ),

      requestedBlockFiles:
        themeBlockSourceFiles,

      loadedBlockFiles:
        blockFiles.map(
          (file) =>
            file.filename,
        ),
    },
  );

  /**
   * Follow render/include dependency từ section + Theme Block
   * source thực tế mà search.json reference.
   *
   * Không scan toàn theme.
   */
  files =
    await loadLiquidDependencies(
      admin,
      theme.id,
      files,
    );

  const maps:
    ThemeMapV4[] = [];

  for (
    const section
    of sections
  ) {
    const filename =
      sectionFilename(
        section.type,
      );

    const sourceFile =
      findSourceFile(
        files,
        filename,
      );

    if (!sourceFile) {
      continue;
    }

    maps.push(
      compileThemeMapV4({
        theme: {
          id:
            numericThemeId(
              theme.id,
            ),

          name:
            theme.name ??
            "Main Theme",
        },

        search: {
          templateFile:
            template.filename,

          templateType:
            "JSON",

          sectionKey:
            section.key,

          sectionType:
            section.type,

          sectionFile:
            sourceFile.filename,
        },

        sourceFile:
          sourceFile.filename,

        source:
          sourceFile.content,

        files,

        /**
         * Theme Block tree thật của section instance
         * lấy trực tiếp từ templates/search.json.
         */
        themeBlocks:
          section.blocks,

        settingResolver:
          createSettingResolver(
            section.settings,
            globalSettings,
          ),
      }),
    );
  }

  return (
    bestCompiledMap(
      maps,
    ) ??
    unsupportedMap(
      theme,
      {
        templateFile:
          template.filename,

        templateType:
          "JSON",
      },

      "SEARCH_SECTION_SOURCE_NOT_FOUND",
    )
  );
}

/**
 * Liquid template flow:
 *
 * templates/search.liquid
 *
 * Có thể:
 *
 * - render search.results trực tiếp
 * - gọi static {% section 'x' %}
 */
async function compileLiquidSearchTemplate(
  admin: AdminGraphqlClient,
  theme: ActiveTheme,
  template:
    ThemeSourceFile,
  initialFiles:
    ThemeSourceFile[],
  globalSettings:
    Record<string, unknown>,
): Promise<ThemeMapV4> {
  const staticSections =
    scanStaticSectionDependencies(
      template.content,
    );

  const sectionFiles =
    await fetchThemeSourceFiles(
      admin,
      theme.id,
      staticSections,
    );

  let files =
    mergeSourceFiles(
      initialFiles,
      sectionFiles,
    );

  files =
    await loadLiquidDependencies(
      admin,
      theme.id,
      files,
    );

  const maps:
    ThemeMapV4[] = [];

  /**
   * Candidate 1:
   * search.liquid tự render results.
   */
  maps.push(
    compileThemeMapV4({
      theme: {
        id:
          numericThemeId(
            theme.id,
          ),

        name:
          theme.name ??
          "Main Theme",
      },

      search: {
        templateFile:
          template.filename,

        templateType:
          "LIQUID",
      },

      sourceFile:
        template.filename,

      source:
        template.content,

      files,

      settingResolver:
        createSettingResolver(
          {},
          globalSettings,
        ),
    }),
  );

  /**
   * Candidate 2+:
   * search.liquid gọi static section.
   */
  for (
    const filename
    of staticSections
  ) {
    const sourceFile =
      findSourceFile(
        files,
        filename,
      );

    if (!sourceFile) {
      continue;
    }

    const sectionType =
      filename
        .replace(
          /^sections\//i,
          "",
        )
        .replace(
          /\.liquid$/i,
          "",
        );

    maps.push(
      compileThemeMapV4({
        theme: {
          id:
            numericThemeId(
              theme.id,
            ),

          name:
            theme.name ??
            "Main Theme",
        },

        search: {
          templateFile:
            template.filename,

          templateType:
            "LIQUID",

          sectionType,

          sectionFile:
            sourceFile.filename,
        },

        sourceFile:
          sourceFile.filename,

        source:
          sourceFile.content,

        files,

        /**
         * Legacy {% section %} settings không nằm trong
         * search.json instance settings.
         *
         * Không fake chúng.
         */
        settingResolver:
          createSettingResolver(
            {},
            globalSettings,
          ),
      }),
    );
  }

  return (
    bestCompiledMap(
      maps,
    ) ??
    unsupportedMap(
      theme,
      {
        templateFile:
          template.filename,

        templateType:
          "LIQUID",
      },

      "SEARCH_LIQUID_RENDERER_NOT_FOUND",
    )
  );
}

/**
 * Build V4 map cho một theme cụ thể.
 *
 * Chưa cache.
 * Chưa dùng storefront.
 * Chưa thay V3.
 */
export async function buildThemeMapV4ForTheme(
  admin: AdminGraphqlClient,
  theme: ActiveTheme,
): Promise<ThemeMapV4> {
  if (
    !theme ||
    theme.processing ||
    theme.processingFailed
  ) {
    throw new Error(
      "THEME_PROCESSING",
    );
  }

  /**
   * Chỉ đọc entry points chuẩn.
   *
   * Không hard-code main-search.
   */
  const entryFiles =
    await fetchThemeSourceFiles(
      admin,
      theme.id,
      [
        "templates/search.json",
        "templates/search.liquid",
        "config/settings_data.json",
      ],
    );

  const searchJson =
    findSourceFile(
      entryFiles,
      "templates/search.json",
    );

  const searchLiquid =
    findSourceFile(
      entryFiles,
      "templates/search.liquid",
    );

  const settingsData =
    findSourceFile(
      entryFiles,
      "config/settings_data.json",
    );

  const globalSettings =
    readGlobalSettings(
      settingsData,
    );

  /**
   * Online Store 2.0:
   * ưu tiên search.json khi tồn tại.
   */
  if (searchJson) {
    return compileJsonSearchTemplate(
      admin,
      theme,
      searchJson,
      entryFiles,
      globalSettings,
    );
  }

  /**
   * Legacy theme.
   */
  if (searchLiquid) {
    return compileLiquidSearchTemplate(
      admin,
      theme,
      searchLiquid,
      entryFiles,
      globalSettings,
    );
  }

  return unsupportedMap(
    theme,
    {
      templateFile:
        "templates/search.json",

      templateType:
        "JSON",
    },

    "SEARCH_TEMPLATE_NOT_FOUND",
  );
}

/**
 * Convenience helper.
 */
export async function buildMainThemeMapV4(
  admin: AdminGraphqlClient,
): Promise<ThemeMapV4> {
  const theme =
    await getActiveTheme(
      admin,
    );

  return buildThemeMapV4ForTheme(
    admin,
    theme,
  );
}