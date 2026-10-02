import {
  parseLiquidDocument,
  type LiquidToken,
} from "./liquid-ast.server";
import {
  buildThemeDependencyGraph,
  type ThemeSourceFile,
} from "./theme-dependency-graph.server";
import {
  compileSourceProvenElementMount,
} from "./theme-mount-compiler.server";
import type {
  ThemeNativePaginationRecipe,
} from "./theme-map-v4.types";

export interface ThemePaginationCompileResult {
  recipe?: ThemeNativePaginationRecipe;
  dependencies: string[];
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

function paginationSnippet(
  token: LiquidToken,
): string | null {
  if (
    token.kind !== "LIQUID_TAG" ||
    (
      token.name !== "render" &&
      token.name !== "include"
    )
  ) {
    return null;
  }

  const markup =
    token.markup?.trim() ?? "";

  const snippet =
    markup.match(
      /^(['"])([^'"]+)\1/,
    )?.[2]
      ?.trim();

  if (!snippet) {
    return null;
  }

  /**
   * Đây là data-flow proof cho pagination object, không dựa vào tên snippet.
   */
  if (
    !/(?:^|,)\s*paginate\s*:\s*paginate(?=\s*(?:,|$))/i.test(
      markup,
    )
  ) {
    return null;
  }

  return `snippets/${snippet
    .replace(/^snippets\//i, "")
    .replace(/\.liquid$/i, "")}.liquid`;
}

function compileSnippetRoot(
  args: {
    file: ThemeSourceFile;
    sectionKey?: string;
    sectionType?: string;
  },
): ThemeNativePaginationRecipe | null {
  const document =
    parseLiquidDocument(
      args.file.content,
    );

  for (const token of document.tokens) {
    if (
      token.kind !== "HTML_OPEN" ||
      !token.tagName
    ) {
      continue;
    }

    const compiled =
      compileSourceProvenElementMount({
        document,
        tokenIndex: token.index,
        sourceFile: args.file.filename,
        sectionKey: args.sectionKey,
        sectionType: args.sectionType,
      });

    if (compiled.status === "PROVEN") {
      return {
        ...compiled.mount,
        scope: "SEARCH_SECTION",
      };
    }
  }

  return null;
}

/**
 * Theo exact dependency graph từ search source tới snippet nhận paginate object.
 * Không scan toàn theme và không hard-code tên pagination/snippet/theme.
 */
export function compileThemeNativePagination(
  args: {
    sourceFile: string;
    files: ThemeSourceFile[];
    sectionKey?: string;
    sectionType?: string;
  },
): ThemePaginationCompileResult {
  const graph =
    buildThemeDependencyGraph({
      entryFile: args.sourceFile,
      files: args.files,
    });

  const reachable = [
    args.sourceFile,
    ...graph.files,
  ].filter(
    (filename, index, values) =>
      values.findIndex(
        (candidate) =>
          normalizeFilename(candidate) ===
          normalizeFilename(filename),
      ) === index,
  );

  for (const filename of reachable) {
    const caller =
      findFile(
        args.files,
        filename,
      );

    if (!caller) continue;

    const document =
      parseLiquidDocument(
        caller.content,
      );

    for (const token of document.tokens) {
      const snippetFilename =
        paginationSnippet(
          token,
        );

      if (!snippetFilename) continue;

      const snippet =
        findFile(
          args.files,
          snippetFilename,
        );

      if (!snippet) continue;

      const recipe =
        compileSnippetRoot({
          file: snippet,
          sectionKey: args.sectionKey,
          sectionType: args.sectionType,
        });

      if (!recipe) continue;

      return {
        recipe,
        dependencies: [
          caller.filename,
          snippet.filename,
        ],
      };
    }
  }

  return {
    dependencies: [],
  };
}
