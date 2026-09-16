export interface ThemeSourceFile {
  filename: string;
  content: string;
  checksum?: string;
}

export interface ThemeDependencyGraphNode {
  filename: string;
  dependencies: string[];
}

export interface ThemeDependencyGraph {
  entryFile: string;
  nodes: ThemeDependencyGraphNode[];
  files: string[];
  missing: string[];
  dynamicDependencies: string[];
}

function normalizeFilename(
  filename: string,
): string {
  return filename
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
}

function normalizeSnippetName(
  value: string,
): string {
  return value
    .trim()
    .replace(/^['"]/, "")
    .replace(/['"]$/, "")
    .replace(/^snippets\//i, "")
    .replace(/\.liquid$/i, "");
}

function normalizeBlockName(
  value: string,
): string {
  return value
    .trim()
    .replace(/^['"]/, "")
    .replace(/['"]$/, "")
    .replace(/^blocks\//i, "")
    .replace(/\.liquid$/i, "");
}

function snippetFilename(
  name: string,
): string {
  return `snippets/${normalizeSnippetName(
    name,
  )}.liquid`;
}

function blockFilename(
  name: string,
): string {
  return `blocks/${normalizeBlockName(
    name,
  )}.liquid`;
}

function findSourceFile(
  files: ThemeSourceFile[],
  filename: string,
): ThemeSourceFile | undefined {
  const target =
    normalizeFilename(
      filename,
    );

  return files.find(
    (file) =>
      normalizeFilename(
        file.filename,
      ) === target,
  );
}

export interface LiquidDependencyScanResult {
  dependencies: string[];
  dynamicDependencies: string[];
}

/**
 * Đọc một argument dạng:
 *
 * type: '_product-card'
 *
 * hoặc:
 *
 * type: block_type
 *
 * Không cố evaluate Liquid expression tại đây.
 *
 * Dependency scanner chỉ có trách nhiệm phân biệt:
 *
 * - static dependency
 * - dynamic dependency
 */
function readNamedArgument(
  markup: string,
  argumentName: string,
):
  | {
      kind: "STATIC";
      value: string;
    }
  | {
      kind: "DYNAMIC";
      expression: string;
    }
  | null {
  const escapedName =
    argumentName.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );

  const pattern =
    new RegExp(
      `(?:^|,)\\s*${escapedName}\\s*:\\s*([^,]+)`,
      "i",
    );

  const match =
    markup.match(
      pattern,
    );

  if (!match) {
    return null;
  }

  const expression =
    match[1].trim();

  const quoted =
    expression.match(
      /^(['"])([\s\S]*?)\1$/,
    );

  if (quoted) {
    return {
      kind: "STATIC",
      value: quoted[2],
    };
  }

  return {
    kind: "DYNAMIC",
    expression,
  };
}

/**
 * Parse dependency từ:
 *
 * {% content_for 'block',
 *   type: '_product-card',
 *   id: 'product-card',
 *   closest.product: product
 * %}
 *
 * Không suy luận tên block từ theme.
 *
 * Chỉ khi source Liquid khai báo rõ:
 *
 * type: 'xyz'
 *
 * thì dependency mới trở thành:
 *
 * blocks/xyz.liquid
 */
function scanContentForDependencies(
  content: string,
  dependencies: Set<string>,
  dynamicDependencies: Set<string>,
): void {
  const contentForRegex =
    /\{%-?\s*content_for\s+([\s\S]*?)-?%\}/gi;

  let match:
    RegExpExecArray | null;

  while (
    (
      match =
        contentForRegex.exec(
          content,
        )
    ) != null
  ) {
    const markup =
      match[1].trim();

    /**
     * Argument đầu tiên của content_for:
     *
     * 'block'
     * 'blocks'
     * hoặc expression động.
     */
    const targetMatch =
      markup.match(
        /^(['"])([^'"]+)\1([\s\S]*)$/,
      );

    if (!targetMatch) {
      const dynamicTarget =
        markup.match(
          /^([A-Za-z_][A-Za-z0-9_.-]*)/,
        );

      if (dynamicTarget) {
        dynamicDependencies.add(
          `content_for:${dynamicTarget[1]}`,
        );
      } else {
        dynamicDependencies.add(
          "content_for:UNKNOWN",
        );
      }

      continue;
    }

    const target =
      targetMatch[2]
        .trim()
        .toLowerCase();

    const argumentsMarkup =
      targetMatch[3] ?? "";

    /**
     * content_for 'block'
     *
     * Đây là một block renderer cụ thể.
     *
     * type static:
     *
     *   type: '_product-card'
     *
     * →
     *
     *   blocks/_product-card.liquid
     */
    if (
      target ===
      "block"
    ) {
      const typeArgument =
        readNamedArgument(
          argumentsMarkup,
          "type",
        );

      if (!typeArgument) {
        dynamicDependencies.add(
          "content_for:block:type:MISSING",
        );

        continue;
      }

      if (
        typeArgument.kind ===
        "STATIC"
      ) {
        const blockName =
          typeArgument.value.trim();

        if (!blockName) {
          dynamicDependencies.add(
            "content_for:block:type:EMPTY",
          );

          continue;
        }

        dependencies.add(
          blockFilename(
            blockName,
          ),
        );

        continue;
      }

      dynamicDependencies.add(
        `content_for:block:type:${typeArgument.expression}`,
      );

      continue;
    }

    /**
     * content_for 'blocks'
     *
     * Đây không trỏ tới một file block duy nhất.
     *
     * Nó render cây child blocks được cấu hình bởi theme.
     *
     * Dependency graph hiện chưa có block-tree resolver,
     * vì vậy phải ghi nhận là dynamic thay vì bỏ qua và
     * vô tình fingerprint thiếu dependency.
     *
     * Bước compiler sau sẽ có thể resolve cây này từ
     * JSON section/block configuration.
     */
    if (
      target ===
      "blocks"
    ) {
      dynamicDependencies.add(
        "content_for:blocks",
      );

      continue;
    }

    /**
     * Một loại content_for khác mà compiler chưa hiểu.
     *
     * Không giả định nó safe.
     */
    dynamicDependencies.add(
      `content_for:${target}`,
    );
  }
}

/**
 * Tìm quan hệ source-file thực sự được Liquid gọi.
 *
 * Hiện hỗ trợ:
 *
 * render 'x'
 * include 'x'
 * content_for 'block', type: 'x'
 *
 * Không dùng filename để đoán x là product card.
 *
 * Static dependency:
 *
 * render 'x'
 *   → snippets/x.liquid
 *
 * content_for 'block', type: 'x'
 *   → blocks/x.liquid
 *
 * Dynamic invocation được ghi riêng để compiler có thể
 * từ chối VERIFIED nếu dependency chưa chứng minh được.
 */
export function scanLiquidDependencies(
  content: string,
): LiquidDependencyScanResult {
  const dependencies =
    new Set<string>();

  const dynamicDependencies =
    new Set<string>();

  /**
   * ============================================================
   * RENDER / INCLUDE
   * ============================================================
   */
  const tagRegex =
    /\{%-?\s*(render|include)\s+([\s\S]*?)-?%\}/gi;

  let match:
    RegExpExecArray | null;

  while (
    (
      match =
        tagRegex.exec(
          content,
        )
    ) != null
  ) {
    const markup =
      match[2].trim();

    const quoted =
      markup.match(
        /^(['"])(.*?)\1/,
      );

    if (quoted) {
      dependencies.add(
        snippetFilename(
          quoted[2],
        ),
      );

      continue;
    }

    /**
     * Ví dụ:
     *
     * {% render renderer_name, product: item %}
     *
     * Dependency runtime động → không thể fingerprint
     * renderer chắc chắn.
     */
    const dynamic =
      markup.match(
        /^([A-Za-z_][A-Za-z0-9_.-]*)/,
      );

    if (dynamic) {
      dynamicDependencies.add(
        `render:${dynamic[1]}`,
      );
    } else {
      dynamicDependencies.add(
        "render:UNKNOWN",
      );
    }
  }

  /**
   * ============================================================
   * CONTENT_FOR BLOCK
   * ============================================================
   *
   * Shopify theme blocks không dùng:
   *
   * {% render '_product-card' %}
   *
   * mà có thể dùng:
   *
   * {% content_for 'block',
   *   type: '_product-card',
   *   closest.product: product
   * %}
   *
   * Nếu không scan đoạn này thì Theme Map sẽ:
   *
   * - thiếu blocks/_product-card.liquid
   * - fingerprint thiếu
   * - runtime analysis thiếu
   * - có thể VERIFIED quá sớm.
   */
  scanContentForDependencies(
    content,
    dependencies,
    dynamicDependencies,
  );

  return {
    dependencies:
      [...dependencies],

    dynamicDependencies:
      [...dynamicDependencies],
  };
}

/**
 * Đi recursive từ renderer source xuống các source file
 * mà renderer thực sự phụ thuộc.
 *
 * Ví dụ:
 *
 * section
 *   ↓
 * content_for 'block', type: '_product-card'
 *   ↓
 * blocks/_product-card.liquid
 *   ↓
 * render 'price'
 *   ↓
 * snippets/price.liquid
 *
 * Không quét toàn theme.
 */
export function buildThemeDependencyGraph(
  options: {
    entryFile: string;
    files: ThemeSourceFile[];
  },
): ThemeDependencyGraph {
  const entryFile =
    normalizeFilename(
      options.entryFile,
    );

  const queue =
    [entryFile];

  const visited =
    new Set<string>();

  const missing =
    new Set<string>();

  const dynamicDependencies =
    new Set<string>();

  const nodes:
    ThemeDependencyGraphNode[] = [];

  while (
    queue.length > 0
  ) {
    const filename =
      queue.shift()!;

    if (
      visited.has(
        filename,
      )
    ) {
      continue;
    }

    visited.add(
      filename,
    );

    const file =
      findSourceFile(
        options.files,
        filename,
      );

    if (!file) {
      missing.add(
        filename,
      );

      continue;
    }

    const scan =
      scanLiquidDependencies(
        file.content,
      );

    const dependencies =
      scan.dependencies.map(
        normalizeFilename,
      );

    nodes.push({
      filename,
      dependencies,
    });

    for (
      const dependency
      of scan.dynamicDependencies
    ) {
      dynamicDependencies.add(
        dependency,
      );
    }

    for (
      const dependency
      of dependencies
    ) {
      if (
        !visited.has(
          dependency,
        )
      ) {
        queue.push(
          dependency,
        );
      }
    }
  }

  return {
    entryFile,

    nodes,

    files:
      [...visited].filter(
        (filename) =>
          !missing.has(
            filename,
          ),
      ),

    missing:
      [...missing],

    dynamicDependencies:
      [...dynamicDependencies],
  };
}

/**
 * Graph chỉ safe nếu:
 *
 * - tất cả dependency tĩnh đều tồn tại;
 * - không còn dependency động chưa resolve.
 */
export function dependencyGraphIsStatic(
  graph: ThemeDependencyGraph,
): boolean {
  return (
    graph.missing.length === 0 &&
    graph.dynamicDependencies.length === 0
  );
}