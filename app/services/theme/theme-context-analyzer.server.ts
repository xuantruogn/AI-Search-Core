import type {
  RendererContextClass,
  ThemeArgumentValue,
} from "./theme-map-v4.types";

export type ContextDependencyKind =
  | "PRODUCT"
  | "EXPLICIT_ARGUMENT"
  | "GLOBAL_OBJECT"
  | "GLOBAL_SETTING"
  | "SECTION_SETTING"
  | "BLOCK_CONTEXT"
  | "SECTION_CONTEXT"
  | "FORLOOP_CONTEXT"
  | "PAGINATE_CONTEXT"
  | "SEARCH_CONTEXT"
  | "CONTENT_FOR_CONTEXT"
  | "CHILDREN_CONTEXT"
  | "UNKNOWN";

export interface ContextDependency {
  expression: string;
  kind: ContextDependencyKind;

  /**
   * Trong V4, resolvable có nghĩa:
   *
   * dependency này KHÔNG chặn renderer.
   *
   * Với argument caller truyền vào:
   * phải được compiler resolve thật.
   *
   * Với biến nội bộ của snippet:
   * chúng có thể là optional/default/nil-safe và không được
   * tự động coi là requirement của renderer contract.
   */
  resolvable: boolean;

  resolvedValue?: ThemeArgumentValue;
}

export interface ContextAnalysis {
  contextClass: RendererContextClass;

  dependencies: ContextDependency[];

  resolvedArguments: Record<
    string,
    ThemeArgumentValue
  >;

  rejectionReasons: string[];
}

export interface ThemeSettingResolver {
  /**
   * section.settings.show_vendor
   */
  resolveSectionSetting?: (
    expression: string,
  ) =>
    | ThemeArgumentValue
    | undefined;

  /**
   * settings.card_style
   */
  resolveGlobalSetting?: (
    expression: string,
  ) =>
    | ThemeArgumentValue
    | undefined;
}

/**
 * Shopify/Liquid global objects có thể được dùng trực tiếp
 * trong storefront Liquid.
 */
const GLOBAL_OBJECTS =
  new Set([
    "shop",
    "routes",
    "request",
    "localization",
    "localization.country",
    "localization.language",
  ]);

function rootExpression(
  expression: string,
): string {
  const value =
    expression.trim();

  /**
   * Ví dụ:
   *
   * product.title | escape
   *
   * →
   *
   * product.title
   */
  return value
    .split("|")[0]
    .trim();
}

function literalToValue(
  expression: string,
):
  | ThemeArgumentValue
  | undefined {
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
    value === "true"
  ) {
    return true;
  }

  if (
    value === "false"
  ) {
    return false;
  }

  if (
    value === "nil" ||
    value === "null"
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

function classifyExpression(
  expression: string,
  productVariable: string,
  explicitArguments: Set<string>,
  resolver: ThemeSettingResolver,
): ContextDependency {
  const normalized =
    rootExpression(
      expression,
    );

  /**
   * ============================================================
   * PRODUCT
   * ============================================================
   */

  if (
    normalized ===
      productVariable ||
    normalized.startsWith(
      `${productVariable}.`,
    )
  ) {
    return {
      expression,
      kind:
        "PRODUCT",
      resolvable:
        true,
    };
  }

  const root =
    normalized.match(
      /^([A-Za-z_][A-Za-z0-9_-]*)/,
    )?.[1];

  /**
   * ============================================================
   * EXPLICIT CALLER ARGUMENT
   * ============================================================
   *
   * Đây mới là renderer contract thật.
   *
   * Ví dụ caller:
   *
   * render 'card-product',
   *   card_product: item,
   *   show_vendor: section.settings.show_vendor
   *
   * Trong snippet:
   *
   * if show_vendor
   *
   * → safe vì show_vendor được caller truyền.
   */

  if (
    root &&
    explicitArguments.has(
      root,
    )
  ) {
    return {
      expression,
      kind:
        "EXPLICIT_ARGUMENT",
      resolvable:
        true,
    };
  }

  /**
   * ============================================================
   * SECTION SETTINGS
   * ============================================================
   *
   * Nếu resolve được từ templates/search.json:
   * lưu value.
   *
   * Nếu KHÔNG resolve được:
   * không reject snippet chỉ vì snippet có internal optional
   * section.settings reference.
   *
   * Required render argument được kiểm ở compiler/call-site,
   * không phải bằng cách quét toàn bộ snippet source.
   */

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

    return {
      expression,

      kind:
        "SECTION_SETTING",

      /**
       * Không block snippet.
       */
      resolvable:
        true,

      ...(value !==
      undefined
        ? {
            resolvedValue:
              value,
          }
        : {}),
    };
  }

  /**
   * ============================================================
   * GLOBAL THEME SETTINGS
   * ============================================================
   *
   * settings.* là Shopify theme-global context.
   *
   * Nếu compiler biết value thì lưu.
   * Nếu không biết thì vẫn không coi nó là missing local argument.
   */

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

    return {
      expression,

      kind:
        "GLOBAL_SETTING",

      resolvable:
        true,

      ...(value !==
      undefined
        ? {
            resolvedValue:
              value,
          }
        : {}),
    };
  }

  /**
   * ============================================================
   * BLOCK INTERNAL CONTEXT
   * ============================================================
   *
   * Quan trọng:
   *
   * Việc snippet có:
   *
   * block.settings.description
   *
   * KHÔNG đồng nghĩa caller bắt buộc phải cung cấp block.
   *
   * Nhiều Shopify snippets có optional branches/default nil.
   *
   * Nếu ORIGINAL render invocation phụ thuộc block context,
   * compiler phải reject ở call-site.
   *
   * Không reject chỉ vì source snippet có reference này.
   */

  if (
    normalized === "block" ||
    normalized.startsWith(
      "block.",
    )
  ) {
    return {
      expression,

      kind:
        "BLOCK_CONTEXT",

      resolvable:
        true,
    };
  }

  /**
   * ============================================================
   * SECTION INTERNAL CONTEXT
   * ============================================================
   */

  if (
    normalized ===
      "section" ||
    normalized.startsWith(
      "section.",
    )
  ) {
    return {
      expression,

      kind:
        "SECTION_CONTEXT",

      resolvable:
        true,
    };
  }

  /**
   * ============================================================
   * FORLOOP INTERNAL CONTEXT
   * ============================================================
   */

  if (
    normalized ===
      "forloop" ||
    normalized.startsWith(
      "forloop.",
    )
  ) {
    return {
      expression,

      kind:
        "FORLOOP_CONTEXT",

      resolvable:
        true,
    };
  }

  /**
   * ============================================================
   * PAGINATE INTERNAL CONTEXT
   * ============================================================
   */

  if (
    normalized ===
      "paginate" ||
    normalized.startsWith(
      "paginate.",
    )
  ) {
    return {
      expression,

      kind:
        "PAGINATE_CONTEXT",

      resolvable:
        true,
    };
  }

  /**
   * ============================================================
   * CONTENT_FOR
   * ============================================================
   */

  if (
    normalized ===
      "content_for" ||
    normalized.startsWith(
      "content_for.",
    )
  ) {
    return {
      expression,

      kind:
        "CONTENT_FOR_CONTEXT",

      resolvable:
        true,
    };
  }

  /**
   * ============================================================
   * CHILDREN
   * ============================================================
   */

  if (
    normalized ===
      "children" ||
    normalized.startsWith(
      "children.",
    )
  ) {
    return {
      expression,

      kind:
        "CHILDREN_CONTEXT",

      resolvable:
        true,
    };
  }

  /**
   * ============================================================
   * SEARCH INTERNAL CONTEXT
   * ============================================================
   *
   * search.* trong snippet không tự động trở thành
   * renderer requirement.
   *
   * Nếu caller truyền search.xxx thành một argument bắt buộc,
   * compiler xử lý expression tại render invocation.
   */

  if (
    normalized ===
      "search" ||
    normalized.startsWith(
      "search.",
    )
  ) {
    return {
      expression,

      kind:
        "SEARCH_CONTEXT",

      resolvable:
        true,
    };
  }

  /**
   * ============================================================
   * KNOWN SHOPIFY GLOBAL OBJECT
   * ============================================================
   */

  for (
    const global
    of GLOBAL_OBJECTS
  ) {
    if (
      normalized ===
        global ||
      normalized.startsWith(
        `${global}.`,
      )
    ) {
      return {
        expression,

        kind:
          "GLOBAL_OBJECT",

        resolvable:
          true,
      };
    }
  }

  /**
   * ============================================================
   * LITERAL
   * ============================================================
   */

  const literal =
    literalToValue(
      normalized,
    );

  if (
    literal !== undefined
  ) {
    return {
      expression,

      kind:
        "EXPLICIT_ARGUMENT",

      resolvable:
        true,

      resolvedValue:
        literal,
    };
  }

  /**
   * ============================================================
   * UNKNOWN SNIPPET INTERNAL VARIABLE
   * ============================================================
   *
   * Ví dụ Dawn card-product:
   *
   * section_id
   * rating_decimal
   * product_form_id
   * horizontal_class
   * extend_height
   * show_quick_add
   * horizontal_quick_add
   *
   * Đây thường là optional snippet parameters.
   *
   * Nếu caller không truyền chúng thì Liquid để nil/default.
   *
   * Không được biến mọi optional variable thành hard dependency.
   *
   * Required variables phải được xác định từ ORIGINAL render
   * invocation, không phải từ việc variable xuất hiện đâu đó
   * trong snippet source.
   */

  return {
    expression,

    kind:
      "UNKNOWN",

    resolvable:
      true,
  };
}

function extractLiquidExpressions(
  source: string,
): string[] {
  const expressions =
    new Set<string>();

  /**
   * ============================================================
   * LIQUID OUTPUT
   *
   * {{ product.title }}
   * ============================================================
   */

  const outputRegex =
    /\{\{-?\s*([\s\S]*?)\s*-?\}\}/g;

  let match:
    RegExpExecArray | null;

  while (
    (
      match =
        outputRegex.exec(
          source,
        )
    ) != null
  ) {
    const expression =
      match[1]
        .trim();

    if (
      expression
    ) {
      expressions.add(
        expression,
      );
    }
  }

  /**
   * ============================================================
   * CONDITIONS
   *
   * if show_vendor
   * unless product.available
   * elsif ...
   * ============================================================
   */

  const conditionRegex =
    /\{%-?\s*(?:if|unless|elsif)\s+([\s\S]*?)\s*-?%\}/g;

  while (
    (
      match =
        conditionRegex.exec(
          source,
        )
    ) != null
  ) {
    const expression =
      match[1]
        .trim();

    if (
      expression
    ) {
      expressions.add(
        expression,
      );
    }
  }

  /**
   * ============================================================
   * DIRECT CONTEXT REFERENCES
   * ============================================================
   *
   * Chỉ dùng cho diagnostics/classification.
   *
   * KHÔNG có nghĩa reference này tự động là required contract.
   */

  const contextRegex =
    /\b(?:section\.settings|section|block|forloop|paginate|search|settings|routes|shop|localization|content_for|children)(?:\.[A-Za-z_][A-Za-z0-9_-]*)*/g;

  while (
    (
      match =
        contextRegex.exec(
          source,
        )
    ) != null
  ) {
    expressions.add(
      match[0],
    );
  }

  return [
    ...expressions,
  ];
}

export function analyzeRendererContext(
  options: {
    source: string;

    /**
     * Product variable thật của snippet.
     *
     * Ví dụ:
     *
     * card_product
     * product
     * item
     */
    productVariable: string;

    /**
     * Argument names ORIGINAL caller truyền vào snippet.
     *
     * Đây là contract quan trọng nhất.
     */
    explicitArguments?: string[];

    settingResolver?: ThemeSettingResolver;
  },
): ContextAnalysis {
  const explicitArguments =
    new Set(
      options.explicitArguments ??
        [],
    );

  const resolver =
    options.settingResolver ??
    {};

  const expressions =
    extractLiquidExpressions(
      options.source,
    );

  const dependencies =
    expressions.map(
      (expression) =>
        classifyExpression(
          expression,
          options.productVariable,
          explicitArguments,
          resolver,
        ),
    );

  const resolvedArguments:
    Record<
      string,
      ThemeArgumentValue
    > = {};

  /**
   * Chỉ lưu những setting mà resolver thật sự
   * lấy được value.
   */
  for (
    const dependency
    of dependencies
  ) {
    if (
      (
        dependency.kind ===
          "SECTION_SETTING" ||
        dependency.kind ===
          "GLOBAL_SETTING"
      ) &&
      dependency.resolvedValue !==
        undefined
    ) {
      resolvedArguments[
        dependency.expression
      ] =
        dependency.resolvedValue;
    }
  }

  /**
   * ============================================================
   * IMPORTANT V4 CONTRACT RULE
   * ============================================================
   *
   * Không reject renderer vì optional/internal variables
   * nằm bên trong snippet.
   *
   * Ví dụ card-product có thể chứa:
   *
   * section_id
   * block.settings.description
   * rating_decimal
   * product_form_id
   * settings.card_style
   *
   * nhưng original render invocation không hề yêu cầu
   * caller phải truyền tất cả chúng.
   *
   * Required call-site arguments được compiler kiểm riêng.
   */

  const rejectionReasons:
    string[] = [];

  /**
   * Nếu có setting resolve thật thì renderer có context
   * được compiler resolve.
   */
  const hasResolvedSetting =
    dependencies.some(
      (dependency) =>
        (
          dependency.kind ===
            "SECTION_SETTING" ||
          dependency.kind ===
            "GLOBAL_SETTING"
        ) &&
        dependency.resolvedValue !==
          undefined,
    );

  /**
   * Nếu snippet dùng internal runtime context thì vẫn ghi nhận
   * là CONTEXTUAL cho diagnostics.
   *
   * CONTEXTUAL ở đây KHÔNG đồng nghĩa REJECTED.
   */
  const hasInternalContext =
    dependencies.some(
      (dependency) =>
        dependency.kind ===
          "BLOCK_CONTEXT" ||
        dependency.kind ===
          "SECTION_CONTEXT" ||
        dependency.kind ===
          "FORLOOP_CONTEXT" ||
        dependency.kind ===
          "PAGINATE_CONTEXT" ||
        dependency.kind ===
          "SEARCH_CONTEXT" ||
        dependency.kind ===
          "CONTENT_FOR_CONTEXT" ||
        dependency.kind ===
          "CHILDREN_CONTEXT" ||
        dependency.kind ===
          "UNKNOWN",
    );

  let contextClass:
    RendererContextClass;

  if (
    hasInternalContext
  ) {
    contextClass =
      "CONTEXTUAL";
  } else if (
    hasResolvedSetting
  ) {
    contextClass =
      "RESOLVABLE";
  } else {
    contextClass =
      "PORTABLE";
  }

  return {
    contextClass,

    dependencies,

    resolvedArguments,

    rejectionReasons,
  };
}