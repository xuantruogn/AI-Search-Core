import { buildThemeMapForTheme, isThemeMapCurrent, type ThemeMap, type AdminGraphqlClient } from "../theme-map.server";
import { readThemeMapStorage, saveThemeMap } from "../theme-map-storage.server";
import { getActiveTheme, type ActiveTheme } from "./theme-reader.server";

const cache = new Map<string, ThemeMap>();
const epochs = new Map<string, number>();
const builds = new Map<string, Promise<ThemeMap>>();

export function invalidateThemeMap(shop: string) {
  cache.delete(shop);
  epochs.set(shop, (epochs.get(shop) ?? 0) + 1);
}

export async function getActiveThemeMap({admin, shop, activeTheme, force = false}: {
  admin: AdminGraphqlClient; shop: string; activeTheme?: ActiveTheme; force?: boolean;
}): Promise<ThemeMap> {
  if (force) invalidateThemeMap(shop);
  const theme = activeTheme ?? await getActiveTheme(admin);
  if (theme.processing || theme.processingFailed) throw new Error("THEME_PROCESSING");
  const epoch = epochs.get(shop) ?? 0;
  const key = `${shop}\0${theme.versionKey}\0${epoch}`;
  const pending = builds.get(key);
  if (pending) return pending;
  const build = (async () => {
    let map = cache.get(shop);
    let previous: Awaited<ReturnType<typeof readThemeMapStorage>> | null = null;
    if (!map || map.theme.versionKey !== theme.versionKey) {
      previous = await readThemeMapStorage(admin, theme.id);
      map = !force ? previous.map ?? undefined : undefined;
    }
    const reusable = map?.theme.versionKey === theme.versionKey && await isThemeMapCurrent(admin, map);
    if (!reusable) {
      previous ??= await readThemeMapStorage(admin, theme.id);
      map = await buildThemeMapForTheme(admin, theme);
      if (!await isThemeMapCurrent(admin, map)) throw new Error("THEME_FILES_CHANGED_DURING_MAP_BUILD");
    }
    if (!map) throw new Error("THEME_MAP_MISSING");
    const confirmed = await getActiveTheme(admin);
    if (confirmed.processing || confirmed.processingFailed || confirmed.versionKey !== theme.versionKey || (epochs.get(shop) ?? 0) !== epoch) throw new Error("ACTIVE_THEME_CHANGED_DURING_MAP_BUILD");
    if (!reusable) await saveThemeMap(admin, map, previous!);
    if ((epochs.get(shop) ?? 0) !== epoch) throw new Error("THEME_MAP_INVALIDATED_DURING_SAVE");
    cache.set(shop, map);
    return map;
  })().finally(() => { builds.delete(key); });
  builds.set(key, build);
  return build;
}
