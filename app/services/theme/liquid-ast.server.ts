export type LiquidTokenKind =
  | "LIQUID_TAG"
  | "LIQUID_OUTPUT"
  | "HTML_OPEN"
  | "HTML_CLOSE"
  | "TEXT";

export interface HtmlAttribute {
  name: string;
  value: string | null;
  dynamic: boolean;
}

export interface HtmlFrame {
  tagName: string;
  start: number;
  rawOpen: string;
  attributes: HtmlAttribute[];
  tokenIndex: number;
}

export interface LiquidFrame {
  name: string;
  markup: string;
  start: number;
  tokenIndex: number;
}

export interface LiquidToken {
  index: number;

  kind: LiquidTokenKind;

  start: number;
  end: number;

  raw: string;

  name?: string;
  markup?: string;

  tagName?: string;

  attributes?: HtmlAttribute[];

  liquidAncestors: LiquidFrame[];
  htmlAncestors: HtmlFrame[];

  matchingTokenIndex?: number;
}

export interface ParsedLiquidDocument {
  source: string;
  tokens: LiquidToken[];
}

const LIQUID_BLOCKS = new Set([
  "for",
  "if",
  "unless",
  "case",
  "capture",
  "paginate",
  "form",
  "tablerow",
  "raw",
  "comment",
  "style",
  "javascript",
  "schema",
]);

const HTML_VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function cloneFrames<T extends object>(
  frames: T[],
): T[] {
  return frames.map((frame) => ({
    ...frame,
  }));
}

function readUntil(
  source: string,
  from: number,
  marker: string,
): number {
  const at = source.indexOf(
    marker,
    from,
  );

  return at < 0
    ? source.length
    : at + marker.length;
}

function parseLiquidTag(
  raw: string,
): {
  name: string;
  markup: string;
} {
  const inner = raw
    .replace(/^\{%-?/, "")
    .replace(/-?%\}$/, "")
    .trim();

  const split =
    inner.search(/\s/);

  if (split < 0) {
    return {
      name: inner.toLowerCase(),
      markup: "",
    };
  }

  return {
    name: inner
      .slice(0, split)
      .toLowerCase(),

    markup: inner
      .slice(split + 1)
      .trim(),
  };
}

function parseAttributes(
  rawOpen: string,
): HtmlAttribute[] {
  const firstSpace =
    rawOpen.search(/\s/);

  if (firstSpace < 0) {
    return [];
  }

  const end =
    rawOpen.lastIndexOf(">");

  const body = rawOpen.slice(
    firstSpace,
    end < 0
      ? rawOpen.length
      : end,
  );

  const attrs: HtmlAttribute[] = [];

  let i = 0;

  while (i < body.length) {
    while (
      i < body.length &&
      /\s|\//.test(body[i])
    ) {
      i++;
    }

    if (i >= body.length) {
      break;
    }

    const nameStart = i;

    while (
      i < body.length &&
      !/[\s=>]/.test(body[i])
    ) {
      i++;
    }

    const name = body
      .slice(nameStart, i)
      .trim();

    if (!name) {
      i++;
      continue;
    }

    while (
      i < body.length &&
      /\s/.test(body[i])
    ) {
      i++;
    }

    let value: string | null = null;

    if (body[i] === "=") {
      i++;

      while (
        i < body.length &&
        /\s/.test(body[i])
      ) {
        i++;
      }

      if (
        body[i] === '"' ||
        body[i] === "'"
      ) {
        const quote = body[i++];

        const start = i;

        while (
          i < body.length &&
          body[i] !== quote
        ) {
          i++;
        }

        value =
          body.slice(start, i);

        if (body[i] === quote) {
          i++;
        }
      } else {
        const start = i;

        while (
          i < body.length &&
          !/\s/.test(body[i])
        ) {
          i++;
        }

        value =
          body.slice(start, i);
      }
    }

    attrs.push({
      name,
      value,

      dynamic:
        value != null &&
        (
          value.includes("{{") ||
          value.includes("{%")
        ),
    });
  }

  return attrs;
}

function parseHtmlOpen(
  raw: string,
): {
  tagName: string;
  attributes: HtmlAttribute[];
  selfClosing: boolean;
} | null {
  const match = raw.match(
    /^<\s*([A-Za-z][\w:-]*)\b/,
  );

  if (!match) {
    return null;
  }

  const tagName =
    match[1].toLowerCase();

  return {
    tagName,

    attributes:
      parseAttributes(raw),

    selfClosing:
      /\/\s*>$/.test(raw) ||
      HTML_VOID.has(tagName),
  };
}

function nextSpecial(
  source: string,
  from: number,
): number {
  const positions = [
    source.indexOf("{%", from),
    source.indexOf("{{", from),
    source.indexOf("<", from),
  ].filter(
    (value) => value >= 0,
  );

  return positions.length
    ? Math.min(...positions)
    : source.length;
}

/**
 * Shopify hỗ trợ:
 *
 * {% liquid
 *   assign x = ...
 *   if ...
 *   render ...
 *   endif
 * %}
 *
 * Ta tách từng statement thành token giả
 * để Data Flow Analyzer xử lý giống Liquid tag bình thường.
 */
function splitLiquidStatements(
  markup: string,
): Array<{
  text: string;
  offset: number;
}> {
  const out: Array<{
    text: string;
    offset: number;
  }> = [];

  let cursor = 0;

  for (
    const line of markup.split(/\r?\n/)
  ) {
    const trimmed =
      line.trim();

    if (trimmed) {
      out.push({
        text: trimmed,

        offset:
          cursor +
          line.indexOf(trimmed),
      });
    }

    cursor +=
      line.length + 1;
  }

  return out;
}

export function parseLiquidDocument(
  source: string,
): ParsedLiquidDocument {
  const tokens: LiquidToken[] = [];

  const liquidStack:
    LiquidFrame[] = [];

  const htmlStack:
    HtmlFrame[] = [];

  let cursor = 0;

  const push = (
    token: Omit<
      LiquidToken,
      | "index"
      | "liquidAncestors"
      | "htmlAncestors"
    >,
  ) => {
    const full: LiquidToken = {
      ...token,

      index:
        tokens.length,

      liquidAncestors:
        cloneFrames(liquidStack),

      htmlAncestors:
        cloneFrames(htmlStack),
    };

    tokens.push(full);

    return full;
  };

  while (
    cursor < source.length
  ) {
    const special =
      nextSpecial(
        source,
        cursor,
      );

    if (special > cursor) {
      push({
        kind: "TEXT",

        start: cursor,
        end: special,

        raw:
          source.slice(
            cursor,
            special,
          ),
      });

      cursor =
        special;

      continue;
    }

    /**
     * Liquid tag:
     *
     * {% for ... %}
     * {% render ... %}
     * {% if ... %}
     */
    if (
      source.startsWith(
        "{%",
        cursor,
      )
    ) {
      const end =
        readUntil(
          source,
          cursor + 2,
          "%}",
        );

      const raw =
        source.slice(
          cursor,
          end,
        );

      const parsed =
        parseLiquidTag(raw);

      /**
       * Pop block trước khi tạo end token.
       *
       * Nhờ vậy endfor/endif không được xem
       * là nằm bên trong chính block nó đóng.
       */
      let matchedLiquidOpen:
        LiquidFrame | undefined;

      if (
        parsed.name.startsWith(
          "end",
        )
      ) {
        const expected =
          parsed.name.slice(3);

        for (
          let i =
            liquidStack.length - 1;
          i >= 0;
          i--
        ) {
          if (
            liquidStack[i].name ===
            expected
          ) {
            matchedLiquidOpen =
              liquidStack[i];

            liquidStack.splice(
              i,
              liquidStack.length - i,
            );

            break;
          }
        }
      }

      const token = push({
        kind: "LIQUID_TAG",

        start: cursor,
        end,

        raw,

        name:
          parsed.name,

        markup:
          parsed.markup,
      });

      if (matchedLiquidOpen) {
        token.matchingTokenIndex =
          matchedLiquidOpen.tokenIndex;

        tokens[
          matchedLiquidOpen.tokenIndex
        ].matchingTokenIndex =
          token.index;
      }

      /**
       * {% liquid %}
       *
       * Biến mỗi line thành LIQUID_TAG
       * synthetic để analyzer không phải
       * có hai implementation khác nhau.
       */
      if (
        parsed.name ===
        "liquid"
      ) {
        for (
          const statement
          of splitLiquidStatements(
            parsed.markup,
          )
        ) {
          const synthetic =
            parseLiquidTag(
              `{% ${statement.text} %}`,
            );

          let matchedSyntheticOpen:
            LiquidFrame | undefined;

          if (
            synthetic.name.startsWith(
              "end",
            )
          ) {
            const expected =
              synthetic.name.slice(3);

            for (
              let i =
                liquidStack.length - 1;
              i >= 0;
              i--
            ) {
              if (
                liquidStack[i].name ===
                expected
              ) {
                matchedSyntheticOpen =
                  liquidStack[i];

                liquidStack.splice(
                  i,
                  liquidStack.length - i,
                );

                break;
              }
            }
          }

          const syntheticToken =
            push({
              kind:
                "LIQUID_TAG",

              start:
                cursor +
                2 +
                statement.offset,

              end:
                cursor +
                2 +
                statement.offset +
                statement.text.length,

              raw:
                `{% ${statement.text} %}`,

              name:
                synthetic.name,

              markup:
                synthetic.markup,
            });

          if (matchedSyntheticOpen) {
            syntheticToken.matchingTokenIndex =
              matchedSyntheticOpen.tokenIndex;

            tokens[
              matchedSyntheticOpen.tokenIndex
            ].matchingTokenIndex =
              syntheticToken.index;
          }

          if (
            LIQUID_BLOCKS.has(
              synthetic.name,
            )
          ) {
            liquidStack.push({
              name:
                synthetic.name,

              markup:
                synthetic.markup,

              start:
                syntheticToken.start,

              tokenIndex:
                syntheticToken.index,
            });
          }
        }
      } else if (
        LIQUID_BLOCKS.has(
          parsed.name,
        )
      ) {
        liquidStack.push({
          name:
            parsed.name,

          markup:
            parsed.markup,

          start: cursor,

          tokenIndex:
            token.index,
        });
      }

      cursor = end;

      continue;
    }

    /**
     * Liquid output:
     *
     * {{ product.title }}
     * {{ item.url }}
     */
    if (
      source.startsWith(
        "{{",
        cursor,
      )
    ) {
      const end =
        readUntil(
          source,
          cursor + 2,
          "}}",
        );

      push({
        kind:
          "LIQUID_OUTPUT",

        start: cursor,
        end,

        raw:
          source.slice(
            cursor,
            end,
          ),
      });

      cursor = end;

      continue;
    }

    /**
     * HTML
     */
    if (
      source[cursor] === "<"
    ) {
      /**
       * HTML comment
       */
      if (
        source.startsWith(
          "<!--",
          cursor,
        )
      ) {
        const end =
          readUntil(
            source,
            cursor + 4,
            "-->",
          );

        push({
          kind: "TEXT",

          start: cursor,
          end,

          raw:
            source.slice(
              cursor,
              end,
            ),
        });

        cursor = end;

        continue;
      }

      const gt =
        source.indexOf(
          ">",
          cursor + 1,
        );

      if (gt < 0) {
        push({
          kind: "TEXT",

          start: cursor,

          end:
            source.length,

          raw:
            source.slice(
              cursor,
            ),
        });

        break;
      }

      const end =
        gt + 1;

      const raw =
        source.slice(
          cursor,
          end,
        );

      /**
       * HTML close tag
       */
      const close =
        raw.match(
          /^<\s*\/\s*([A-Za-z][\w:-]*)\s*>/,
        );

      if (close) {
        const tagName =
          close[1].toLowerCase();

        let openFrameIndex = -1;

        for (
          let i =
            htmlStack.length - 1;
          i >= 0;
          i--
        ) {
          if (
            htmlStack[i].tagName ===
            tagName
          ) {
            openFrameIndex = i;
            break;
          }
        }

        let matchedOpen:
          HtmlFrame | undefined;

        if (
          openFrameIndex >= 0
        ) {
          matchedOpen =
            htmlStack[
              openFrameIndex
            ];

          htmlStack.splice(
            openFrameIndex,
            htmlStack.length -
              openFrameIndex,
          );
        }

        const token =
          push({
            kind:
              "HTML_CLOSE",

            start:
              cursor,

            end,

            raw,

            tagName,
          });

        if (matchedOpen) {
          token.matchingTokenIndex =
            matchedOpen.tokenIndex;

          tokens[
            matchedOpen.tokenIndex
          ].matchingTokenIndex =
            token.index;
        }

        cursor = end;

        continue;
      }

      /**
       * HTML open tag
       */
      const parsed =
        parseHtmlOpen(raw);

      if (parsed) {
        const token =
          push({
            kind:
              "HTML_OPEN",

            start:
              cursor,

            end,

            raw,

            tagName:
              parsed.tagName,

            attributes:
              parsed.attributes,
          });

        if (
          !parsed.selfClosing
        ) {
          htmlStack.push({
            tagName:
              parsed.tagName,

            start:
              cursor,

            rawOpen:
              raw,

            attributes:
              parsed.attributes,

            tokenIndex:
              token.index,
          });
        }

        cursor = end;

        continue;
      }
    }

    /**
     * Không nhận diện được special token
     * thì giữ nguyên thành text.
     */
    push({
      kind:
        "TEXT",

      start:
        cursor,

      end:
        cursor + 1,

      raw:
        source[cursor],
    });

    cursor++;
  }

  return {
    source,
    tokens,
  };
}

/**
 * Lấy expression bên trong:
 *
 * {{ product.title }}
 *
 * →
 *
 * product.title
 */
export function tokenInnerExpression(
  token: LiquidToken,
): string {
  if (
    token.kind !==
    "LIQUID_OUTPUT"
  ) {
    return "";
  }

  return token.raw
    .replace(
      /^\{\{-?/,
      "",
    )
    .replace(
      /-?\}\}$/,
      "",
    )
    .trim();
}

/**
 * Chỉ trả attribute khi giá trị hoàn toàn static.
 *
 * Ví dụ:
 *
 * id="SearchResults"
 * → SearchResults
 *
 * class="{{ section.settings.class }}"
 * → null
 */
export function staticAttribute(
  frame: HtmlFrame,
  name: string,
): string | null {
  const attr =
    frame.attributes.find(
      (value) =>
        value.name.toLowerCase() ===
        name.toLowerCase(),
    );

  return attr &&
    !attr.dynamic
    ? attr.value
    : null;
}