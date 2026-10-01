type AdminGraphqlClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

export type ShopLocaleOption = {
  locale: string;
  name: string;
  primary: boolean;
  published: boolean;
  source: "SHOPIFY" | "FALLBACK";
};

export const FALLBACK_SEARCH_LOCALES: ShopLocaleOption[] = [
  ["en", "English"],
  ["vi", "Vietnamese"],
  ["fr", "French"],
  ["de", "German"],
  ["es", "Spanish"],
  ["it", "Italian"],
  ["pt", "Portuguese"],
  ["pt-BR", "Portuguese (Brazil)"],
  ["nl", "Dutch"],
  ["sv", "Swedish"],
  ["da", "Danish"],
  ["no", "Norwegian"],
  ["fi", "Finnish"],
  ["pl", "Polish"],
  ["cs", "Czech"],
  ["hu", "Hungarian"],
  ["ro", "Romanian"],
  ["tr", "Turkish"],
  ["ru", "Russian"],
  ["uk", "Ukrainian"],
  ["ar", "Arabic"],
  ["he", "Hebrew"],
  ["hi", "Hindi"],
  ["th", "Thai"],
  ["id", "Indonesian"],
  ["ms", "Malay"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["zh-Hans", "Chinese (Simplified)"],
  ["zh-Hant", "Chinese (Traditional)"],
].map(([locale, name]) => ({
  locale,
  name,
  primary: false,
  published: false,
  source: "FALLBACK" as const,
}));

export async function getEnabledShopLocales(
  admin: AdminGraphqlClient,
): Promise<ShopLocaleOption[]> {
  const response = await admin.graphql(`#graphql
    query AiSearchShopLocales {
      shopLocales {
        locale
        name
        primary
        published
      }
    }
  `);

  const json = (await response.json()) as {
    data?: {
      shopLocales?: Array<{
        locale?: string | null;
        name?: string | null;
        primary?: boolean | null;
        published?: boolean | null;
      }> | null;
    };
    errors?: Array<{ message?: string }>;
  };

  if (!response.ok || json.errors?.length) {
    throw new Error(
      json.errors?.map((error) => error.message).filter(Boolean).join("; ") ||
        `Unable to read shop locales (${response.status})`,
    );
  }

  return (json.data?.shopLocales ?? [])
    .filter(
      (item): item is {
        locale: string;
        name: string;
        primary?: boolean | null;
        published?: boolean | null;
      } => Boolean(item.locale?.trim() && item.name?.trim()),
    )
    .map((item) => ({
      locale: item.locale.trim(),
      name: item.name.trim(),
      primary: item.primary === true,
      published: item.published === true,
      source: "SHOPIFY" as const,
    }))
    .sort((left, right) => {
      if (left.primary !== right.primary) return left.primary ? -1 : 1;
      if (left.published !== right.published) return left.published ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
}

function mergeSupportedLocales(
  shopifyLocales: ShopLocaleOption[],
): ShopLocaleOption[] {
  const merged = new Map<string, ShopLocaleOption>();

  for (const item of FALLBACK_SEARCH_LOCALES) {
    merged.set(item.locale.toLowerCase(), item);
  }

  // Shopify metadata wins for matching locales, while the supported AI Search
  // list remains visible even when that language is not published on the shop.
  for (const item of shopifyLocales) {
    merged.set(item.locale.toLowerCase(), item);
  }

  return [...merged.values()].sort((left, right) => {
    if (left.primary !== right.primary) return left.primary ? -1 : 1;
    if (left.published !== right.published) return left.published ? -1 : 1;
    if (left.source !== right.source) return left.source === "SHOPIFY" ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

export async function getShopLocalesWithFallback(
  admin: AdminGraphqlClient,
): Promise<{
  options: ShopLocaleOption[];
  usingFallback: boolean;
  error: string | null;
}> {
  try {
    const shopifyLocales = await getEnabledShopLocales(admin);
    return {
      options: mergeSupportedLocales(shopifyLocales),
      usingFallback: false,
      error:
        shopifyLocales.length > 0
          ? null
          : "Shopify returned no enabled locales.",
    };
  } catch (error) {
    return {
      options: FALLBACK_SEARCH_LOCALES,
      usingFallback: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function isSupportedFallbackLocale(locale: string) {
  const normalized = locale.trim().toLowerCase();
  return FALLBACK_SEARCH_LOCALES.some(
    (item) => item.locale.toLowerCase() === normalized,
  );
}
