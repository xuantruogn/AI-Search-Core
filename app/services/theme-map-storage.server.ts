// App-installation metafield storage from the supplied ai-search architecture.
// Numeric keys match Liquid theme.id; compareDigest prevents stale overwrites.
import { numericThemeId, type AdminGraphqlClient, type ThemeMap } from "./theme-map.server";

export async function readThemeMapStorage(admin: AdminGraphqlClient, themeId: string) {
  const key = `theme_map_${numericThemeId(themeId)}`;
  const response = await admin.graphql(`#graphql
    query ReadThemeMapStorage($key: String!) {
      currentAppInstallation {
        id
        metafield(namespace: "ai_search", key: $key) { value compareDigest }
      }
    }`, {variables:{key}});
  const json = await response.json();
  if (!response.ok || json.errors?.length || !json.data?.currentAppInstallation?.id) throw new Error("THEME_MAP_STORAGE_READ_FAILED");
  const installation = json.data.currentAppInstallation;
  let map: ThemeMap | null = null;
  try {
    const parsed = JSON.parse(installation.metafield?.value ?? "null");
    if (parsed?.version === 3 && parsed.theme?.id === numericThemeId(themeId) && parsed.theme?.gid === themeId &&
        Array.isArray(parsed.sources) && parsed.sources.length > 0 && parsed.sources.length <= 1003 &&
        typeof parsed.fingerprint === "string" && parsed.search?.searchTemplate) map = parsed;
  } catch { /* Rebuild maps written with an earlier schema. */ }
  return {ownerId:installation.id as string, key, compareDigest:installation.metafield?.compareDigest ?? null, map};
}

export async function saveThemeMap(admin: AdminGraphqlClient, themeMap: ThemeMap, previous: Awaited<ReturnType<typeof readThemeMapStorage>>) {
  if (previous.key !== `theme_map_${themeMap.theme.id}`) throw new Error("THEME_MAP_STORAGE_ID_MISMATCH");
  const response = await admin.graphql(`#graphql
    mutation SaveThemeMap($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id key }
        userErrors { message code }
      }
    }`, {variables:{metafields:[{ownerId:previous.ownerId,namespace:"ai_search",key:previous.key,type:"json",value:JSON.stringify(themeMap),compareDigest:previous.compareDigest}]}});
  const json = await response.json();
  if (!response.ok || json.errors?.length || json.data?.metafieldsSet?.userErrors?.length || !json.data?.metafieldsSet?.metafields?.[0]?.id) {
    throw new Error("THEME_MAP_SAVE_FAILED_OR_CONCURRENT_UPDATE");
  }
  return themeMap;
}
