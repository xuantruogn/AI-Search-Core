import type {
  HtmlAttribute,
  HtmlFrame,
  LiquidToken,
  ParsedLiquidDocument,
} from "./liquid-ast.server";

import type {
  ThemeMountRecipe,
} from "./theme-map-v4.types";

export type ThemeMountCompileResult =
  | {
      status: "PROVEN";
      mount: ThemeMountRecipe;
      reason?: never;
    }
  | {
      status: "UNSUPPORTED";
      reason: string;
      mount?: never;
    };

interface SelectorDescriptor {
  selector: string;

  matches: (
    token: LiquidToken,
  ) => boolean;
}

/**
 * Escape value dùng bên trong CSS attribute selector.
 */
function cssString(
  value: string,
): string {
  return value
    .replace(
      /\\/g,
      "\\\\",
    )
    .replace(
      /"/g,
      '\\"',
    );
}

function attributesOf(
  token: LiquidToken,
): HtmlAttribute[] {
  return (
    token.attributes ??
    []
  );
}

function frameAttribute(
  frame: HtmlFrame,
  name: string,
): HtmlAttribute | undefined {
  const wanted =
    name.toLowerCase();

  return frame
    .attributes
    .find(
      (attribute) =>
        attribute.name
          .toLowerCase() ===
        wanted,
    );
}

function tokenAttribute(
  token: LiquidToken,
  name: string,
): HtmlAttribute | undefined {
  const wanted =
    name.toLowerCase();

  return attributesOf(
    token,
  ).find(
    (attribute) =>
      attribute.name
        .toLowerCase() ===
      wanted,
  );
}

function staticFrameAttribute(
  frame: HtmlFrame,
  name: string,
): HtmlAttribute | null {
  const attribute =
    frameAttribute(
      frame,
      name,
    );

  if (
    !attribute ||
    attribute.dynamic
  ) {
    return null;
  }

  return attribute;
}

function staticTokenAttribute(
  token: LiquidToken,
  name: string,
): HtmlAttribute | null {
  const attribute =
    tokenAttribute(
      token,
      name,
    );

  if (
    !attribute ||
    attribute.dynamic
  ) {
    return null;
  }

  return attribute;
}

function htmlOpenTokens(
  document: ParsedLiquidDocument,
): LiquidToken[] {
  return document.tokens.filter(
    (token) =>
      token.kind ===
        "HTML_OPEN" &&
      typeof token.tagName ===
        "string",
  );
}

/**
 * Chuyển HTML_OPEN token thành HtmlFrame.
 *
 * Mount compiler chỉ cần:
 *
 * tokenIndex
 * tagName
 * attributes
 */
function frameFromOpenToken(
  token: LiquidToken,
): HtmlFrame | null {
  if (
    token.kind !==
      "HTML_OPEN" ||
    !token.tagName
  ) {
    return null;
  }

  return {
    tokenIndex:
      token.index,

    tagName:
      token.tagName,

    attributes:
      token.attributes ??
      [],
  } as HtmlFrame;
}

/**
 * Element A bao element/token B khi:
 *
 * A open trước B
 *
 * và
 *
 * A close sau B.
 *
 * Không phụ thuộc htmlAncestors cache.
 */
function tokenEnclosesIndex(
  token: LiquidToken,
  targetIndex: number,
): boolean {
  return (
    token.kind ===
      "HTML_OPEN" &&
    token.index <
      targetIndex &&
    token.matchingTokenIndex != null &&
    token.matchingTokenIndex >
      targetIndex
  );
}

/**
 * Trả ancestor HTML thật theo source:
 *
 * outer
 * ↓
 * inner
 */
function enclosingHtmlFrames(
  document: ParsedLiquidDocument,
  targetIndex: number,
): HtmlFrame[] {
  return htmlOpenTokens(
    document,
  )
    .filter(
      (token) =>
        tokenEnclosesIndex(
          token,
          targetIndex,
        ),
    )
    .sort(
      (left, right) =>
        left.index -
        right.index,
    )
    .map(
      frameFromOpenToken,
    )
    .filter(
      (
        frame,
      ): frame is HtmlFrame =>
        frame != null,
    );
}

/**
 * Parent HTML trực tiếp của một token.
 *
 * Ancestor gần nhất = opening token có index lớn nhất
 * nhưng vẫn bao target.
 */
function directHtmlParentTokenIndex(
  document: ParsedLiquidDocument,
  targetIndex: number,
): number | null {
  let parent:
    LiquidToken | null =
    null;

  for (
    const token
    of htmlOpenTokens(
      document,
    )
  ) {
    if (
      !tokenEnclosesIndex(
        token,
        targetIndex,
      )
    ) {
      continue;
    }

    if (
      !parent ||
      token.index >
        parent.index
    ) {
      parent =
        token;
    }
  }

  return (
    parent?.index ??
    null
  );
}

function countMatchingTokens(
  document: ParsedLiquidDocument,
  descriptor: SelectorDescriptor,
): number {
  let count = 0;

  for (
    const token
    of htmlOpenTokens(
      document,
    )
  ) {
    if (
      descriptor.matches(
        token,
      )
    ) {
      count += 1;
    }
  }

  return count;
}

function simpleIdSelector(
  id: string,
): string {
  if (
    /^[A-Za-z_][A-Za-z0-9_-]*$/.test(
      id,
    )
  ) {
    return `#${id}`;
  }

  return `[id="${cssString(
    id,
  )}"]`;
}

function idDescriptor(
  frame: HtmlFrame,
): SelectorDescriptor | null {
  const attribute =
    staticFrameAttribute(
      frame,
      "id",
    );

  const id =
    attribute?.value
      ?.trim();

  if (!id) {
    return null;
  }

  return {
    selector:
      simpleIdSelector(
        id,
      ),

    matches: (
      token:
        LiquidToken,
    ) => {
      if (
        token.kind !==
        "HTML_OPEN"
      ) {
        return false;
      }

      return (
        staticTokenAttribute(
          token,
          "id",
        )?.value ===
        id
      );
    },
  };
}

function staticDataAttributes(
  frame: HtmlFrame,
): HtmlAttribute[] {
  return frame
    .attributes
    .filter(
      (attribute) =>
        attribute.name
          .toLowerCase()
          .startsWith(
            "data-",
          ) &&
        !attribute.dynamic,
    );
}

function dataDescriptor(
  frame: HtmlFrame,
): SelectorDescriptor | null {
  const attribute =
    staticDataAttributes(
      frame,
    )[0];

  if (!attribute) {
    return null;
  }

  const name =
    attribute.name;

  const value =
    attribute.value;

  const selector =
    value == null
      ? `[${name}]`
      : `[${name}="${cssString(
          value,
        )}"]`;

  return {
    selector,

    matches: (
      token:
        LiquidToken,
    ) => {
      if (
        token.kind !==
        "HTML_OPEN"
      ) {
        return false;
      }

      const candidate =
        staticTokenAttribute(
          token,
          name,
        );

      if (!candidate) {
        return false;
      }

      return (
        candidate.value ===
        value
      );
    },
  };
}

function roleDescriptor(
  frame: HtmlFrame,
): SelectorDescriptor | null {
  const attribute =
    staticFrameAttribute(
      frame,
      "role",
    );

  const value =
    attribute?.value
      ?.trim();

  if (!value) {
    return null;
  }

  const tagName =
    frame.tagName
      .toLowerCase();

  return {
    selector:
      `${tagName}[role="${cssString(
        value,
      )}"]`,

    matches: (
      token:
        LiquidToken,
    ) => {
      if (
        token.kind !==
          "HTML_OPEN" ||
        token.tagName
          ?.toLowerCase() !==
          tagName
      ) {
        return false;
      }

      return (
        staticTokenAttribute(
          token,
          "role",
        )?.value ===
        value
      );
    },
  };
}

function staticClasses(
  frame: HtmlFrame,
): string[] {
  const attribute =
    staticFrameAttribute(
      frame,
      "class",
    );

  const value =
    attribute?.value;

  if (!value) {
    return [];
  }

  return value
    .split(/\s+/)
    .map(
      (item) =>
        item.trim(),
    )
    .filter(
      (item) =>
        /^[A-Za-z_][A-Za-z0-9_-]*$/.test(
          item,
        ),
    );
}

function tokenStaticClasses(
  token: LiquidToken,
): Set<string> {
  const attribute =
    staticTokenAttribute(
      token,
      "class",
    );

  const value =
    attribute?.value;

  if (!value) {
    return new Set();
  }

  return new Set(
    value
      .split(/\s+/)
      .map(
        (item) =>
          item.trim(),
      )
      .filter(Boolean),
  );
}

function classDescriptor(
  frame: HtmlFrame,
): SelectorDescriptor | null {
  const classes =
    staticClasses(
      frame,
    );

  if (
    classes.length === 0
  ) {
    return null;
  }

  const tagName =
    frame.tagName
      .toLowerCase();

  return {
    selector:
      `${tagName}${classes
        .map(
          (className) =>
            `.${className}`,
        )
        .join("")}`,

    matches: (
      token:
        LiquidToken,
    ) => {
      if (
        token.kind !==
          "HTML_OPEN" ||
        token.tagName
          ?.toLowerCase() !==
          tagName
      ) {
        return false;
      }

      const tokenClasses =
        tokenStaticClasses(
          token,
        );

      return classes.every(
        (className) =>
          tokenClasses.has(
            className,
          ),
      );
    },
  };
}

function tagDescriptor(
  frame: HtmlFrame,
): SelectorDescriptor {
  const tagName =
    frame.tagName
      .toLowerCase();

  return {
    selector:
      tagName,

    matches: (
      token:
        LiquidToken,
    ) =>
      token.kind ===
        "HTML_OPEN" &&
      token.tagName
        ?.toLowerCase() ===
        tagName,
  };
}

/**
 * Descriptor cho child segment.
 *
 * Ưu tiên:
 *
 * role
 * data
 * classes
 * tag
 */
function descriptorsForFrame(
  frame: HtmlFrame,
): SelectorDescriptor[] {
  const result:
    SelectorDescriptor[] =
    [];

  const role =
    roleDescriptor(
      frame,
    );

  if (role) {
    result.push(
      role,
    );
  }

  const data =
    dataDescriptor(
      frame,
    );

  if (data) {
    const tagName =
      frame.tagName
        .toLowerCase();

    result.push({
      selector:
        `${tagName}${data.selector}`,

      matches: (
        token:
          LiquidToken,
      ) =>
        token.tagName
          ?.toLowerCase() ===
          tagName &&
        data.matches(
          token,
        ),
    });
  }

  const classes =
    classDescriptor(
      frame,
    );

  if (classes) {
    result.push(
      classes,
    );
  }

  result.push(
    tagDescriptor(
      frame,
    ),
  );

  return result;
}

/**
 * Anchor phải unique trong source section.
 */
function uniqueAnchorDescriptor(
  document: ParsedLiquidDocument,
  frame: HtmlFrame,
): {
  descriptor:
    SelectorDescriptor;

  strategy:
    | "ELEMENT_ID"
    | "DATA_ATTRIBUTE"
    | "SOURCE_PROVEN_SELECTOR";
} | null {
  /**
   * ID.
   */
  const id =
    idDescriptor(
      frame,
    );

  if (
    id &&
    countMatchingTokens(
      document,
      id,
    ) === 1
  ) {
    return {
      descriptor:
        id,

      strategy:
        "ELEMENT_ID",
    };
  }

  /**
   * data-*.
   */
  const data =
    dataDescriptor(
      frame,
    );

  if (
    data &&
    countMatchingTokens(
      document,
      data,
    ) === 1
  ) {
    return {
      descriptor:
        data,

      strategy:
        "DATA_ATTRIBUTE",
    };
  }

  /**
   * Static classes.
   */
  const classes =
    classDescriptor(
      frame,
    );

  if (
    classes &&
    countMatchingTokens(
      document,
      classes,
    ) === 1
  ) {
    return {
      descriptor:
        classes,

      strategy:
        "SOURCE_PROVEN_SELECTOR",
    };
  }

  /**
   * Role.
   */
  const role =
    roleDescriptor(
      frame,
    );

  if (
    role &&
    countMatchingTokens(
      document,
      role,
    ) === 1
  ) {
    return {
      descriptor:
        role,

      strategy:
        "SOURCE_PROVEN_SELECTOR",
    };
  }

  return null;
}

/**
 * Direct children dựa trên matchingTokenIndex,
 * không dựa htmlAncestors snapshot.
 */
function directChildrenOf(
  document: ParsedLiquidDocument,
  parentTokenIndex: number,
): LiquidToken[] {
  return htmlOpenTokens(
    document,
  ).filter(
    (token) =>
      directHtmlParentTokenIndex(
        document,
        token.index,
      ) ===
      parentTokenIndex,
  );
}

/**
 * Chứng minh descriptor chọn đúng 1 child target
 * bên trong parent.
 */
function proveDirectChild(
  document: ParsedLiquidDocument,
  parent: HtmlFrame,
  target: HtmlFrame,
  descriptor: SelectorDescriptor,
): boolean {
  const matches =
    directChildrenOf(
      document,
      parent.tokenIndex,
    ).filter(
      (token) =>
        descriptor.matches(
          token,
        ),
    );

  return (
    matches.length === 1 &&
    matches[0].index ===
      target.tokenIndex
  );
}

/**
 * Xây:
 *
 * anchor
 * >
 * child
 * >
 * child
 *
 * Mỗi segment đều được chứng minh từ source.
 */
function anchorDescriptorsForFrame(
  frame: HtmlFrame,
): SelectorDescriptor[] {
  const result:
    SelectorDescriptor[] =
    [];

  const id =
    idDescriptor(
      frame,
    );

  if (id) {
    result.push(
      id,
    );
  }

  const data =
    dataDescriptor(
      frame,
    );

  if (data) {
    result.push(
      data,
    );
  }

  const classes =
    classDescriptor(
      frame,
    );

  if (classes) {
    result.push(
      classes,
    );
  }

  const role =
    roleDescriptor(
      frame,
    );

  if (role) {
    result.push(
      role,
    );
  }

  return result;
}

/**
 * Đếm target cuối cùng của một selector path dựa hoàn toàn
 * trên source tree đã parse.
 *
 * Anchor không bắt buộc phải unique nếu toàn bộ path sau khi
 * nối direct-child selector chứng minh chỉ còn đúng target.
 *
 * Ví dụ source có hai #product-grid ở hai Liquid branch:
 *
 * #product-grid
 * #product-grid > ul[role="list"]
 *
 * Anchor riêng lẻ match 2, nhưng full path chỉ match đúng
 * product-grid branch thực sự chứa product loop.
 */
function matchingPathTargets(
  document: ParsedLiquidDocument,
  anchorDescriptor: SelectorDescriptor,
  childDescriptors: SelectorDescriptor[],
): LiquidToken[] {
  let current =
    htmlOpenTokens(
      document,
    ).filter(
      (token) =>
        anchorDescriptor.matches(
          token,
        ),
    );

  for (
    const descriptor
    of childDescriptors
  ) {
    const next:
      LiquidToken[] =
      [];

    for (
      const parent
      of current
    ) {
      for (
        const child
        of directChildrenOf(
          document,
          parent.index,
        )
      ) {
        if (
          descriptor.matches(
            child,
          )
        ) {
          next.push(
            child,
          );
        }
      }
    }

    current =
      next;

    if (
      current.length === 0
    ) {
      break;
    }
  }

  return current;
}

function selectorFromAnchorPath(
  document: ParsedLiquidDocument,
  frames: HtmlFrame[],
  anchorIndex: number,
): string | null {
  const anchor =
    frames[
      anchorIndex
    ];

  /**
   * Fast path cũ:
   * nếu anchor tự unique, ưu tiên đúng strategy/descriptor
   * đã được compiler chứng minh trước đây.
   */
  const uniqueAnchor =
    uniqueAnchorDescriptor(
      document,
      anchor,
    );

  const anchorDescriptors =
    uniqueAnchor
      ? [
          uniqueAnchor
            .descriptor,
        ]
      : anchorDescriptorsForFrame(
          anchor,
        );

  for (
    const anchorDescriptor
    of anchorDescriptors
  ) {
    let selector =
      anchorDescriptor
        .selector;

    const childDescriptors:
      SelectorDescriptor[] =
      [];

    let pathProven =
      true;

    for (
      let index =
        anchorIndex + 1;
      index <
        frames.length;
      index += 1
    ) {
      const parent =
        frames[
          index - 1
        ];

      const target =
        frames[
          index
        ];

      let proven:
        SelectorDescriptor | null =
        null;

      for (
        const descriptor
        of descriptorsForFrame(
          target,
        )
      ) {
        if (
          proveDirectChild(
            document,
            parent,
            target,
            descriptor,
          )
        ) {
          proven =
            descriptor;

          break;
        }
      }

      if (!proven) {
        pathProven =
          false;

        break;
      }

      childDescriptors.push(
        proven,
      );

      selector +=
        ` > ${proven.selector}`;
    }

    if (
      !pathProven
    ) {
      continue;
    }

    const targets =
      matchingPathTargets(
        document,
        anchorDescriptor,
        childDescriptors,
      );

    const expectedTarget =
      frames[
        frames.length - 1
      ];

    if (
      targets.length === 1 &&
      targets[0].index ===
        expectedTarget.tokenIndex
    ) {
      return selector;
    }
  }

  return null;
}

/**
 * Chỉ identity mạnh mới được mount trực tiếp.
 *
 * role/class đơn không đủ mạnh cho toàn storefront.
 */
function strongDirectMountRecipe(
  document: ParsedLiquidDocument,
  frame: HtmlFrame,
  args: {
    sourceFile: string;
    sectionKey?: string;
    sectionType?: string;
  },
): ThemeMountRecipe | null {
  /**
   * ID.
   */
  const id =
    idDescriptor(
      frame,
    );

  if (
    id &&
    countMatchingTokens(
      document,
      id,
    ) === 1
  ) {
    return {
      sectionKey:
        args.sectionKey,

      sectionType:
        args.sectionType,

      strategy:
        "ELEMENT_ID",

      selector:
        id.selector,

      sourceFile:
        args.sourceFile,

      verification: {
        expectedTag:
          frame.tagName
            .toLowerCase(),

        expectedMatchCount:
          1,
      },
    };
  }

  /**
   * data-*.
   */
  const data =
    dataDescriptor(
      frame,
    );

  if (
    data &&
    countMatchingTokens(
      document,
      data,
    ) === 1
  ) {
    return {
      sectionKey:
        args.sectionKey,

      sectionType:
        args.sectionType,

      strategy:
        "DATA_ATTRIBUTE",

      selector:
        data.selector,

      sourceFile:
        args.sourceFile,

      verification: {
        expectedTag:
          frame.tagName
            .toLowerCase(),

        expectedMatchCount:
          1,
      },
    };
  }

  return null;
}

/**
 * Tìm HTML container trực tiếp chứa vòng product loop.
 *
 * Dựa trên token range:
 *
 * openingToken.index
 * <
 * loop.index
 * <
 * openingToken.matchingTokenIndex
 */
function findProductLoopContainer(
  document: ParsedLiquidDocument,
  itemLoopTokenIndex: number,
): HtmlFrame | null {
  const loopToken =
    document.tokens[
      itemLoopTokenIndex
    ];

  const loopEndTokenIndex =
    loopToken
      ?.matchingTokenIndex;

  let nearest:
    LiquidToken | null =
    null;

  for (
    const token
    of htmlOpenTokens(
      document,
    )
  ) {
    const enclosesLoop =
      loopEndTokenIndex != null
        ? (
            token.index <
              itemLoopTokenIndex &&
            token.matchingTokenIndex != null &&
            token.matchingTokenIndex >
              loopEndTokenIndex
          )
        : tokenEnclosesIndex(
            token,
            itemLoopTokenIndex,
          );

    if (
      !enclosesLoop
    ) {
      continue;
    }

    if (
      !nearest ||
      token.index >
        nearest.index
    ) {
      nearest =
        token;
    }
  }

  if (!nearest) {
    return null;
  }

  return frameFromOpenToken(
    nearest,
  );
}

/**
 * Renderer phải nằm trong product loop.
 */
function rendererBelongsToLoop(
  document: ParsedLiquidDocument,
  rendererTokenIndex: number,
  itemLoopTokenIndex: number,
): boolean {
  const renderer =
    document.tokens[
      rendererTokenIndex
    ];

  const loop =
    document.tokens[
      itemLoopTokenIndex
    ];

  if (
    !renderer ||
    !loop ||
    loop.matchingTokenIndex == null
  ) {
    /**
     * Fallback sang liquidAncestors vì parser hiện tại
     * đã chứng minh đường data-flow bằng cơ chế này.
     */
    return Boolean(
      renderer?.liquidAncestors
        .some(
          (ancestor) =>
            ancestor.tokenIndex ===
              itemLoopTokenIndex,
        ),
    );
  }

  return (
    rendererTokenIndex >
      itemLoopTokenIndex &&
    rendererTokenIndex <
      loop.matchingTokenIndex
  );
}

/**
 * Xây đầy đủ source-proven ancestry:
 *
 * outer HTML
 * ↓
 * ...
 * ↓
 * parent
 * ↓
 * mount
 *
 * Không dùng loopToken.htmlAncestors.
 */
function buildMountFramePath(
  document: ParsedLiquidDocument,
  mountFrame: HtmlFrame,
): HtmlFrame[] {
  const ancestors =
    enclosingHtmlFrames(
      document,
      mountFrame.tokenIndex,
    );

  return [
    ...ancestors,
    mountFrame,
  ];
}

/**
 * Theme Mount V4.
 *
 * Nguyên tắc:
 *
 * - mount là container trực tiếp của repeated product item
 * - selector được derive từ source thật
 * - không hard-code Dawn
 * - không dùng global selector mơ hồ nếu có ancestor mạnh
 * - runtime vẫn phải verify selector match đúng 1 node
 */
export function compileThemeMount(
  args: {
    document:
      ParsedLiquidDocument;

    rendererTokenIndex:
      number;

    itemLoopTokenIndex:
      number;

    sourceFile:
      string;

    sectionKey?:
      string;

    sectionType?:
      string;
  },
): ThemeMountCompileResult {
  const {
    document,
    rendererTokenIndex,
    itemLoopTokenIndex,
    sourceFile,
    sectionKey,
    sectionType,
  } = args;

  /**
   * Guard product loop.
   */
  if (
    !rendererBelongsToLoop(
      document,
      rendererTokenIndex,
      itemLoopTokenIndex,
    )
  ) {
    return {
      status:
        "UNSUPPORTED",

      reason:
        "RENDERER_NOT_INSIDE_PRODUCT_LOOP",
    };
  }

  /**
   * Tìm container trực tiếp của vòng for.
   */
  const mountFrame =
    findProductLoopContainer(
      document,
      itemLoopTokenIndex,
    );

  if (!mountFrame) {
    return {
      status:
        "UNSUPPORTED",

      reason:
        "PRODUCT_LOOP_HTML_CONTAINER_NOT_FOUND",
    };
  }

  /**
   * Nếu chính mount có identity mạnh,
   * dùng trực tiếp.
   */
  const direct =
    strongDirectMountRecipe(
      document,
      mountFrame,
      {
        sourceFile,
        sectionKey,
        sectionType,
      },
    );

  if (direct) {
    return {
      status:
        "PROVEN",

      mount:
        direct,
    };
  }

  /**
   * Dựng ancestry bằng source interval.
   *
   * Ví dụ:
   *
   * div#product-grid
   *   ↓
   * ul[role=list]
   */
  const frames =
    buildMountFramePath(
      document,
      mountFrame,
    );

  const mountIndex =
    frames.length - 1;

  /**
   * Tìm anchor gần mount nhất trước.
   *
   * Dawn kỳ vọng:
   *
   * #product-grid
   */
  for (
    let anchorIndex =
      mountIndex - 1;
    anchorIndex >= 0;
    anchorIndex -= 1
  ) {
    const selector =
      selectorFromAnchorPath(
        document,
        frames,
        anchorIndex,
      );

    if (!selector) {
      continue;
    }

    return {
      status:
        "PROVEN",

      mount: {
        sectionKey,

        sectionType,

        strategy:
          "SOURCE_PROVEN_SELECTOR",

        selector,

        sourceFile,

        verification: {
          expectedTag:
            mountFrame
              .tagName
              .toLowerCase(),

          expectedMatchCount:
            1,
        },
      },
    };
  }

  /**
   * Không có source-proven scoped selector.
   *
   * Không fallback về:
   *
   * ul
   * ul[role=list]
   * .product-grid
   *
   * vì có nguy cơ mount nhầm trên storefront.
   */
  return {
    status:
      "UNSUPPORTED",

    reason:
      "SOURCE_PROVEN_MOUNT_NOT_FOUND",
  };
}