import { buildClientThemeMapDTO, type AdminGraphqlClient, type ThemeMap } from "./theme-map.server";

export async function readThemeMapStorage(admin: AdminGraphqlClient, _themeId?: string) {
  const response = await admin.graphql(`#graphql
    query ReadThemeMapShopStorage {
      shop {
        id
        metafield(namespace: "app", key: "theme_map") {
          id
          namespace
          key
          type
          value
          compareDigest
        }
      }
    }`);

  const json = await response.json();
  if (!response.ok || json.errors?.length || !json.data?.shop?.id) {
    throw new Error("THEME_MAP_STORAGE_READ_FAILED");
  }

  const shop = json.data.shop;
  let map: any = null;
  try {
    map = JSON.parse(shop.metafield?.value ?? "null");
  } catch {
    /* JSON parse error */
  }

  return {
    ownerId: shop.id as string,
    key: "theme_map",
    compareDigest: shop.metafield?.compareDigest ?? null,
    map,
  };
}

export async function saveThemeMap(
  admin: AdminGraphqlClient,
  themeMap: ThemeMap,
  _previous?: Awaited<ReturnType<typeof readThemeMapStorage>>
) {
  const shopQuery = await admin.graphql(`query { shop { id } }`);
  const shopData = await shopQuery.json();
  const shopGid = shopData.data?.shop?.id;

  if (!shopGid) {
    throw new Error("SHOP_ID_NOT_FOUND");
  }

  const clientDto = buildClientThemeMapDTO(themeMap);

  const response = await admin.graphql(`#graphql
    mutation SaveThemeMapToShop($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id key namespace }
        userErrors { message code field }
      }
    }`, {
      variables: {
        metafields: [
          {
            ownerId: shopGid,
            namespace: "app",
            key: "theme_map",
            type: "json",
            value: JSON.stringify(clientDto),
          }
        ]
      }
    });

  const json = await response.json();
  if (json.data?.metafieldsSet?.userErrors?.length > 0) {
    console.error("[STORAGE] Errors writing Shop Metafield:", json.data.metafieldsSet.userErrors);
    throw new Error(`METAFIELD_WRITE_FAILED: ${json.data.metafieldsSet.userErrors[0].message}`);
  }

  return themeMap;
}