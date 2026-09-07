export type ThemeFile = {
  filename: string;
  content: string;
  checksumMd5: string | null;
  updatedAt: string | null;
};

export type ActiveTheme = {
  id: string;
  name: string;
  updatedAt: string;
  processing: boolean;
  processingFailed: boolean;
  versionKey: string;
};

type AdminGraphqlClient = {
  graphql: (
    query: string,
    options?: {
      variables?: Record<string, unknown>;
    },
  ) => Promise<Response>;
};

type GraphqlError = { message?: string };

type ThemeFilesPayload = {
  data?: {
    theme?: {
      files?: {
        nodes?: Array<{
          filename?: string;
          checksumMd5?: string | null;
          updatedAt?: string | null;
          body?: { content?: string } | null;
        }>;
        pageInfo?: {
          hasNextPage?: boolean;
          endCursor?: string | null;
        };
        userErrors?: Array<{ code?: string; filename?: string }>;
      };
    } | null;
  };
  errors?: GraphqlError[];
};

function errorMessage(
  response: Response,
  errors: GraphqlError[] | undefined,
  fallback: string,
) {
  return (
    errors
      ?.map((error) => error.message)
      .filter(Boolean)
      .join("; ") || `${fallback} (${response.status})`
  );
}

function collectThemeFiles(
  payload: ThemeFilesPayload,
  target: Map<string, ThemeFile>,
) {
  for (const file of payload.data?.theme?.files?.nodes ?? []) {
    if (!file.filename || typeof file.body?.content !== "string") continue;
    target.set(file.filename, {
      filename: file.filename,
      content: file.body.content,
      checksumMd5:
        typeof file.checksumMd5 === "string" ? file.checksumMd5 : null,
      updatedAt: typeof file.updatedAt === "string" ? file.updatedAt : null,
    });
  }
}

export function activeThemeVersionKey(theme: {
  id: string;
  updatedAt: string;
}) {
  return `${theme.id}\u0000${theme.updatedAt}`;
}

/**
 * Reads the live MAIN theme identity on every preflight. `updatedAt` is part of
 * the version key, so publishing a different theme OR editing files/settings of
 * the same live theme invalidates a renderer catalog before OpenAI is called.
 */
export async function getActiveTheme(
  admin: AdminGraphqlClient,
): Promise<ActiveTheme> {
  const response = await admin.graphql(`#graphql
    query GetActiveThemeIdentity {
      themes(first: 10, roles: [MAIN]) {
        nodes {
          id
          name
          role
          updatedAt
          processing
          processingFailed
        }
      }
    }
  `);

  const json = (await response.json()) as {
    data?: {
      themes?: {
        nodes?: Array<{
          id?: string;
          name?: string;
          updatedAt?: string;
          processing?: boolean;
          processingFailed?: boolean;
        }>;
      };
    };
    errors?: GraphqlError[];
  };

  if (!response.ok || json.errors?.length) {
    throw new Error(
      errorMessage(response, json.errors, "Unable to read active theme"),
    );
  }

  const theme = json.data?.themes?.nodes?.[0];

  if (!theme?.id || !theme.name || !theme.updatedAt) {
    throw new Error("Không tìm thấy active MAIN theme hợp lệ");
  }

  const result: ActiveTheme = {
    id: theme.id,
    name: theme.name,
    updatedAt: theme.updatedAt,
    processing: Boolean(theme.processing),
    processingFailed: Boolean(theme.processingFailed),
    versionKey: "",
  };
  result.versionKey = activeThemeVersionKey(result);
  return result;
}

export async function getThemeFiles(
  admin: AdminGraphqlClient,
  themeId: string,
  filenames: string[],
): Promise<Map<string, ThemeFile>> {
  const uniqueFilenames = [...new Set(filenames.map((name) => name.trim()))]
    .filter(Boolean)
    .slice(0, 50);

  if (uniqueFilenames.length === 0) return new Map();

  const response = await admin.graphql(
    `#graphql
      query GetThemeFiles($themeId: ID!, $filenames: [String!]!) {
        theme(id: $themeId) {
          files(filenames: $filenames, first: 50) {
            nodes {
              filename
              checksumMd5
              updatedAt
              body {
                ... on OnlineStoreThemeFileBodyText {
                  content
                }
              }
            }
            userErrors {
              code
              filename
            }
          }
        }
      }
    `,
    {
      variables: {
        themeId,
        filenames: uniqueFilenames,
      },
    },
  );

  const json = (await response.json()) as ThemeFilesPayload;

  if (!response.ok || json.errors?.length) {
    throw new Error(
      errorMessage(response, json.errors, "Unable to read theme files"),
    );
  }

  if (!json.data?.theme) {
    throw new Error(`Theme not found or inaccessible: ${themeId}`);
  }

  const result = new Map<string, ThemeFile>();
  collectThemeFiles(json, result);
  return result;
}

/**
 * Discovers theme source by Shopify-supported filename wildcards instead of
 * assuming Dawn/Horizon/theme-family filenames.
 */
export async function getThemeFilesByPatterns(
  admin: AdminGraphqlClient,
  themeId: string,
  patterns: string[],
  options: {
    pageSize?: number;
    maxFiles?: number;
    maxPages?: number;
  } = {},
): Promise<Map<string, ThemeFile>> {
  const uniquePatterns = [...new Set(patterns.map((pattern) => pattern.trim()))]
    .filter(Boolean)
    .slice(0, 50);

  if (uniquePatterns.length === 0) return new Map();

  const pageSize = Math.max(1, Math.min(options.pageSize ?? 100, 250));
  const maxFiles = Math.max(1, Math.min(options.maxFiles ?? 1_000, 2_500));
  const maxPages = Math.max(1, Math.min(options.maxPages ?? 25, 50));
  const result = new Map<string, ThemeFile>();

  let after: string | null = null;

  for (let page = 0; page < maxPages && result.size < maxFiles; page += 1) {
    const response = await admin.graphql(
      `#graphql
        query DiscoverThemeFiles(
          $themeId: ID!
          $filenames: [String!]!
          $first: Int!
          $after: String
        ) {
          theme(id: $themeId) {
            files(
              filenames: $filenames
              first: $first
              after: $after
            ) {
              nodes {
                filename
                checksumMd5
                updatedAt
                body {
                  ... on OnlineStoreThemeFileBodyText {
                    content
                  }
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
              userErrors {
                code
                filename
              }
            }
          }
        }
      `,
      {
        variables: {
          themeId,
          filenames: uniquePatterns,
          first: Math.min(pageSize, maxFiles - result.size),
          after,
        },
      },
    );

    const json = (await response.json()) as ThemeFilesPayload;

    if (!response.ok || json.errors?.length) {
      throw new Error(
        errorMessage(response, json.errors, "Unable to discover theme files"),
      );
    }

    if (!json.data?.theme) {
      throw new Error(`Theme not found or inaccessible: ${themeId}`);
    }

    collectThemeFiles(json, result);

    const pageInfo = json.data.theme.files?.pageInfo;
    if (!pageInfo?.hasNextPage) break;
    if (!pageInfo.endCursor || pageInfo.endCursor === after || result.size >= maxFiles || page + 1 >= maxPages) {
      throw new Error("THEME_DISCOVERY_INCOMPLETE");
    }
    after = pageInfo.endCursor;
  }

  return result;
}

export async function getThemeFile(
  admin: AdminGraphqlClient,
  themeId: string,
  filename: string,
): Promise<ThemeFile | null> {
  const files = await getThemeFiles(admin, themeId, [filename]);
  return files.get(filename) ?? null;
}
