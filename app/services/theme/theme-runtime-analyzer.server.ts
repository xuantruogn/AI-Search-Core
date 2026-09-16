import type {
  RendererRuntimeMode,
} from "./theme-map-v4.types";

export interface RuntimeEvidence {
  kind:
    | "CUSTOM_ELEMENT"
    | "SCRIPT_REFERENCE"
    | "INLINE_SCRIPT"
    | "EVENT_ATTRIBUTE"
    | "STATIC_MARKUP";

  value: string;
}

export interface ThemeRuntimeAnalysis {
  mode:
    RendererRuntimeMode;

  customElement?: string;

  evidence:
    RuntimeEvidence[];

  rejectionReasons:
    string[];
}

function unique<T>(
  values: T[],
): T[] {
  return [
    ...new Set(values),
  ];
}

function customElementsInSource(
  source: string,
): string[] {
  const names:
    string[] = [];

  /**
   * HTML custom element spec yêu cầu dấu '-'.
   *
   * Ví dụ:
   *
   * <product-card>
   * <quick-add>
   * <variant-selects>
   *
   * Không suy luận tên nào có ý nghĩa gì.
   */
  const regex =
    /<\s*([a-z][a-z0-9]*-[a-z0-9-]+)\b/gi;

  let match:
    RegExpExecArray | null;

  while (
    (
      match =
        regex.exec(source)
    ) != null
  ) {
    names.push(
      match[1].toLowerCase(),
    );
  }

  return unique(names);
}

function scriptReferences(
  source: string,
): string[] {
  const result:
    string[] = [];

  const regex =
    /<script\b([^>]*)>/gi;

  let match:
    RegExpExecArray | null;

  while (
    (
      match =
        regex.exec(source)
    ) != null
  ) {
    const attributes =
      match[1];

    const src =
      attributes.match(
        /\bsrc\s*=\s*["']([^"']+)["']/i,
      );

    if (src?.[1]) {
      result.push(
        src[1],
      );
    }
  }

  return unique(result);
}

function hasInlineScript(
  source: string,
): boolean {
  return (
    /<script\b(?![^>]*\bsrc\s*=)[^>]*>[\s\S]*?<\/script>/i.test(
      source,
    )
  );
}

function eventAttributes(
  source: string,
): string[] {
  const result:
    string[] = [];

  /**
   * onclick/onchange...
   *
   * Native inline handlers vẫn hoạt động sau DOM insertion,
   * nhưng đây là runtime evidence cần biết.
   */
  const regex =
    /\s(on[a-z]+)\s*=/gi;

  let match:
    RegExpExecArray | null;

  while (
    (
      match =
        regex.exec(source)
    ) != null
  ) {
    result.push(
      match[1].toLowerCase(),
    );
  }

  return unique(result);
}

/**
 * Chỉ phân tích renderer fragment.
 *
 * Không quét JS toàn theme để đoán function initializer.
 */
export function analyzeThemeRendererRuntime(
  source: string,
): ThemeRuntimeAnalysis {
  const evidence:
    RuntimeEvidence[] = [];

  const rejectionReasons:
    string[] = [];

  const customElements =
    customElementsInSource(
      source,
    );

  for (
    const element
    of customElements
  ) {
    evidence.push({
      kind:
        "CUSTOM_ELEMENT",

      value:
        element,
    });
  }

  const scripts =
    scriptReferences(
      source,
    );

  for (
    const script
    of scripts
  ) {
    evidence.push({
      kind:
        "SCRIPT_REFERENCE",

      value:
        script,
    });
  }

  if (
    hasInlineScript(
      source,
    )
  ) {
    evidence.push({
      kind:
        "INLINE_SCRIPT",

      value:
        "inline-script",
    });
  }

  for (
    const event
    of eventAttributes(
      source,
    )
  ) {
    evidence.push({
      kind:
        "EVENT_ATTRIBUTE",

      value:
        event,
    });
  }

  /**
   * Renderer tự nhúng script là tín hiệu nguy hiểm.
   *
   * Nếu fragment được mount lại nhiều lần,
   * script có thể execute/reinitialize không dự đoán được.
   */
  if (
    scripts.length > 0 ||
    hasInlineScript(source)
  ) {
    rejectionReasons.push(
      "RENDERER_EMBEDS_SCRIPT",
    );

    return {
      mode:
        "UNSUPPORTED",

      evidence,

      rejectionReasons,
    };
  }

  /**
   * Custom Elements là trường hợp tương đối an toàn:
   *
   * browser tự gọi connectedCallback khi node
   * được insert vào document nếu element đã được define.
   *
   * Không cần đoán initializer.
   */
  if (
    customElements.length > 0
  ) {
    return {
      mode:
        "CUSTOM_ELEMENT",

      customElement:
        customElements[0],

      evidence,

      rejectionReasons: [],
    };
  }

  /**
   * onclick/onchange inline không cần app gọi initializer.
   */
  if (
    evidence.some(
      (entry) =>
        entry.kind ===
        "EVENT_ATTRIBUTE",
    )
  ) {
    return {
      mode:
        "STATIC",

      evidence,

      rejectionReasons: [],
    };
  }

  evidence.push({
    kind:
      "STATIC_MARKUP",

    value:
      "no-runtime-dependency-detected",
  });

  return {
    mode:
      "STATIC",

    evidence,

    rejectionReasons: [],
  };
}