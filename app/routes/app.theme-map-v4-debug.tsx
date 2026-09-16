import type {
  LoaderFunctionArgs,
} from "react-router";

import {
  useLoaderData,
} from "react-router";

import {
  authenticate,
} from "../shopify.server";

import {
  getActiveTheme,
  getThemeFiles,
} from "../services/theme/theme-reader.server";

import {
  getActiveThemeMapV4,
  rebuildActiveThemeMapV4,
} from "../services/theme/theme-map-v4-lifecycle.server";

function featureEnabled(): boolean {
  return (
    process.env
      .AI_SEARCH_THEME_MAP_V4 ===
    "true"
  );
}

function asRecord(
  value: unknown,
): Record<string, unknown> | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }

  return value as Record<
    string,
    unknown
  >;
}

function inspectSearchJson(
  source: string | null,
) {
  if (source === null) {
    return {
      exists: false,
      length: 0,
      parse_status:
        "FILE_NOT_FOUND",
      root_type: null,
      root_keys: [],
      sections_type: null,
      section_keys: [],
      sections: [],
      order: null,
      raw_source: null,
    };
  }

  let parsed:
    unknown =
    null;

  let parseError:
    string | null =
    null;

  try {
    parsed =
      JSON.parse(source);
  } catch (error) {
    parseError =
      error instanceof Error
        ? error.message
        : String(error);
  }

  const root =
    asRecord(parsed);

  const rawSections =
    root
      ? root.sections
      : null;

  const sections =
    asRecord(
      rawSections,
    );

  const sectionDiagnostics =
    sections
      ? Object.entries(
          sections,
        ).map(
          (
            [
              key,
              value,
            ],
          ) => {
            const section =
              asRecord(
                value,
              );

            return {
              key,

              value_type:
                Array.isArray(
                  value,
                )
                  ? "array"
                  : value ===
                      null
                    ? "null"
                    : typeof value,

              is_object:
                section !==
                null,

              type:
                section &&
                typeof section.type ===
                  "string"
                  ? section.type
                  : null,

              disabled:
                section
                  ? section.disabled ??
                    null
                  : null,

              settings_type:
                section
                  ? Array.isArray(
                      section.settings,
                    )
                    ? "array"
                    : section.settings ===
                        null
                      ? "null"
                      : typeof section.settings
                  : null,

              raw:
                value,
            };
          },
        )
      : [];

  return {
    exists: true,

    length:
      source.length,

    parse_status:
      parseError
        ? "JSON_PARSE_ERROR"
        : root
          ? "OK"
          : "ROOT_NOT_OBJECT",

    parse_error:
      parseError,

    root_type:
      Array.isArray(
        parsed,
      )
        ? "array"
        : parsed === null
          ? "null"
          : typeof parsed,

    root_keys:
      root
        ? Object.keys(
            root,
          )
        : [],

    sections_type:
      Array.isArray(
        rawSections,
      )
        ? "array"
        : rawSections ===
            null
          ? "null"
          : typeof rawSections,

    section_keys:
      sections
        ? Object.keys(
            sections,
          )
        : [],

    sections:
      sectionDiagnostics,

    order:
      root?.order ??
      null,

    raw_source:
      source,
  };
}

function findThemeFileContent(
  files:
    Awaited<
      ReturnType<
        typeof getThemeFiles
      >
    >,

  filename: string,
): string | null {
  const direct =
    files.get(
      filename,
    );

  if (direct) {
    return direct.content;
  }

  const normalized =
    filename
      .replace(
        /\\/g,
        "/",
      )
      .toLowerCase();

  for (
    const file
    of files.values()
  ) {
    if (
      file.filename
        .replace(
          /\\/g,
          "/",
        )
        .toLowerCase() ===
      normalized
    ) {
      return file.content;
    }
  }

  return null;
}

export const loader = async ({
  request,
}: LoaderFunctionArgs) => {
  const {
    admin,
    session,
  } =
    await authenticate.admin(
      request,
    );

  if (
    !featureEnabled()
  ) {
    return {
      status:
        "disabled" as const,

      feature:
        "theme-map-v4",

      message:
        "AI_SEARCH_THEME_MAP_V4 is not enabled",
    };
  }

  const url =
    new URL(
      request.url,
    );

  const rebuild =
    url.searchParams.get(
      "rebuild",
    ) === "1";

  try {
    const activeTheme =
      await getActiveTheme(
        admin,
      );

    // ============================================================
    // SOURCE PROBE
    // Đọc trực tiếp entry search từ Shopify.
    // Không phụ thuộc compiler V4.
    // ============================================================

    const sourceFiles =
      await getThemeFiles(
        admin,
        activeTheme.id,
        [
          "templates/search.json",
          "templates/search.liquid",
        ],
      );

    const searchJsonSource =
      findThemeFileContent(
        sourceFiles,
        "templates/search.json",
      );

    const searchLiquidSource =
      findThemeFileContent(
        sourceFiles,
        "templates/search.liquid",
      );

    const sourceProbe = {
      returned_files:
        [
          ...sourceFiles.values(),
        ].map(
          (file) => ({
            filename:
              file.filename,

            checksumMd5:
              file.checksumMd5,

            updatedAt:
              file.updatedAt,

            contentLength:
              file.content.length,
          }),
        ),

      search_json:
        inspectSearchJson(
          searchJsonSource,
        ),

      search_liquid: {
        exists:
          searchLiquidSource !==
          null,

        length:
          searchLiquidSource
            ?.length ??
          0,

        raw_source:
          searchLiquidSource,
      },
    };

    // ============================================================
    // V4 MAP
    // ============================================================

    const map =
      rebuild
        ? await rebuildActiveThemeMapV4({
            admin,

            shop:
              session.shop,
          })
        : await getActiveThemeMapV4({
            admin,

            shop:
              session.shop,

            activeTheme,
          });

    const eligible =
      map.rendererCandidates.filter(
        (candidate) =>
          candidate.status ===
            "ELIGIBLE" &&
          candidate.mount != null,
      );

    return {
      status:
        "success" as const,

      feature:
        "theme-map-v4",

      rebuild,

      active_theme: {
        id:
          activeTheme.id,

        name:
          activeTheme.name,

        updatedAt:
          activeTheme.updatedAt,

        versionKey:
          activeTheme.versionKey ??
          null,
      },

      // Quan trọng cho bước debug hiện tại.
      source_probe:
        sourceProbe,

      theme_map:
        map,

      diagnostics: {
        map_status:
          map.status,

        fingerprint:
          map.fingerprint,

        dependency_count:
          map.dependencies.length,

        candidate_count:
          map.rendererCandidates.length,

        eligible_candidate_count:
          eligible.length,

        selected_candidate:
          eligible[0]
            ? {
                id:
                  eligible[0].id,

                type:
                  eligible[0].type,

                snippet:
                  eligible[0]
                    .snippet ??
                  null,

                product_binding:
                  eligible[0]
                    .productBinding,

                context_class:
                  eligible[0]
                    .contextClass,

                runtime:
                  eligible[0]
                    .runtime,

                score:
                  eligible[0]
                    .score,

                mount:
                  eligible[0]
                    .mount,

                dependencies:
                  eligible[0]
                    .dependencies,
              }
            : null,

        rejected_candidates:
          map.rendererCandidates
            .filter(
              (candidate) =>
                candidate.status ===
                "REJECTED",
            )
            .map(
              (candidate) => ({
                id:
                  candidate.id,

                type:
                  candidate.type,

                snippet:
                  candidate.snippet ??
                  null,

                score:
                  candidate.score,

                rejectionReasons:
                  candidate
                    .rejectionReasons,
              }),
            ),

        unsupported_reason:
          map.status ===
          "UNSUPPORTED"
            ? map.unsupportedReason
            : null,
      },
    };
  } catch (
    error
  ) {
    return {
      status:
        "error" as const,

      feature:
        "theme-map-v4",

      rebuild,

      message:
        error instanceof Error
          ? error.message
          : String(error),
    };
  }
};

export default function ThemeMapV4DebugRoute() {
  const data =
    useLoaderData<
      typeof loader
    >();

  return (
    <div
      style={{
        padding:
          "24px",

        maxWidth:
          "1400px",

        margin:
          "0 auto",
      }}
    >
      <h1
        style={{
          marginBottom:
            "8px",
        }}
      >
        Theme Map V4 Debug
      </h1>

      <p
        style={{
          marginTop:
            0,

          marginBottom:
            "16px",
        }}
      >
        Status:{" "}
        <strong>
          {data.status}
        </strong>
      </p>

      <pre
        style={{
          margin:
            0,

          padding:
            "16px",

          overflow:
            "auto",

          whiteSpace:
            "pre-wrap",

          wordBreak:
            "break-word",

          border:
            "1px solid #d9d9d9",

          borderRadius:
            "8px",

          background:
            "#f6f6f7",

          color:
            "#202223",

          fontSize:
            "13px",

          lineHeight:
            1.5,
        }}
      >
        {JSON.stringify(
          data,
          null,
          2,
        )}
      </pre>
    </div>
  );
}