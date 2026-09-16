import { createHash } from "node:crypto";

import {
  getActiveTheme,
  getThemeFiles,
  type ActiveTheme,
} from "./theme-reader.server";

import {
  buildThemeMapV4ForTheme,
  type AdminGraphqlClient,
} from "./theme-map-v4-shopify.server";

import {
  loadStoredThemeMapV4,
  refreshStoredThemeMapV4Version,
  saveStoredThemeMapV4,
  touchStoredThemeMapV4Usage,
} from "./theme-map-v4-store.server";

import type {
  ThemeDependency,
  ThemeMapV4,
} from "./theme-map-v4.types";

interface ThemeMapV4CacheEntry {
  shop: string;
  themeGid: string;
  themeVersionKey: string;
  map: ThemeMapV4;
  cachedAt: number;
}

export interface GetActiveThemeMapV4Options {
  admin: AdminGraphqlClient;
  shop: string;
  activeTheme?: ActiveTheme;
  forceRebuild?: boolean;
}

export interface ThemeMapV4CurrentCheck {
  current: boolean;

  reason:
    | "CURRENT"
    | "THEME_CHANGED"
    | "DEPENDENCY_CHANGED"
    | "DEPENDENCY_MISSING"
    | "NO_DEPENDENCIES";

  changedFiles: string[];
}

const cache = new Map<
  string,
  ThemeMapV4CacheEntry
>();

/**
 * Deduplicate concurrent rebuilds for the same shop/theme snapshot.
 */
const inFlight = new Map<
  string,
  Promise<ThemeMapV4>
>();

function normalizeShop(shop: string): string {
  return shop.trim().toLowerCase();
}

function normalizeFilename(filename: string): string {
  return filename
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .toLowerCase();
}

function numericThemeId(id: string): string {
  return (
    id.match(
      /^(?:gid:\/\/shopify\/OnlineStoreTheme\/)?(\d+)$/,
    )?.[1] ?? id
  );
}

function themeVersionKey(theme: ActiveTheme): string {
  const explicit = (
    theme as ActiveTheme & {
      versionKey?: string;
    }
  ).versionKey;

  if (
    typeof explicit === "string" &&
    explicit
  ) {
    return explicit;
  }

  return [
    theme.id,
    theme.updatedAt ?? "",
  ].join(":");
}

function sha256(value: string): string {
  return createHash("sha256")
    .update(value)
    .digest("hex");
}

function cacheKey(shop: string): string {
  return normalizeShop(shop);
}

function buildInFlightKey(
  shop: string,
  theme: ActiveTheme,
): string {
  return [
    normalizeShop(shop),
    theme.id,
    themeVersionKey(theme),
  ].join(":");
}

function mapMatchesTheme(
  map: ThemeMapV4,
  theme: ActiveTheme,
): boolean {
  return (
    String(map.theme.id) ===
    numericThemeId(theme.id)
  );
}

function setRamCache(args: {
  shop: string;
  theme: ActiveTheme;
  map: ThemeMapV4;
}): void {
  cache.set(
    cacheKey(args.shop),
    {
      shop: normalizeShop(args.shop),
      themeGid: args.theme.id,
      themeVersionKey:
        themeVersionKey(args.theme),
      map: args.map,
      cachedAt: Date.now(),
    },
  );
}

async function readCurrentDependencyChecksums(
  admin: AdminGraphqlClient,
  theme: ActiveTheme,
  dependencies: ThemeDependency[],
): Promise<Map<string, string>> {
  const result =
    new Map<string, string>();

  if (
    dependencies.length === 0
  ) {
    return result;
  }

  const filenames = [
    ...new Set(
      dependencies.map(
        (dependency) =>
          dependency.filename,
      ),
    ),
  ];

  for (
    let offset = 0;
    offset < filenames.length;
    offset += 50
  ) {
    const batch =
      filenames.slice(
        offset,
        offset + 50,
      );

    const files =
      await getThemeFiles(
        admin,
        theme.id,
        batch,
      );

    const returned =
      new Map<string, string>();

    for (
      const file
      of files.values()
    ) {
      returned.set(
        normalizeFilename(
          file.filename,
        ),
        sha256(
          file.content,
        ),
      );
    }

    for (
      const filename
      of batch
    ) {
      const normalized =
        normalizeFilename(
          filename,
        );

      result.set(
        normalized,
        returned.get(
          normalized,
        ) ??
          "MISSING",
      );
    }
  }

  return result;
}

/**
 * Verify only compiler-proven dependencies.
 *
 * This is not a recompile.
 * Unrelated theme edits such as footer changes do not invalidate the map.
 */
export async function isThemeMapV4Current(
  admin: AdminGraphqlClient,
  theme: ActiveTheme,
  map: ThemeMapV4,
): Promise<ThemeMapV4CurrentCheck> {
  if (
    !mapMatchesTheme(
      map,
      theme,
    )
  ) {
    return {
      current: false,
      reason: "THEME_CHANGED",
      changedFiles: [],
    };
  }

  if (
    map.dependencies.length === 0
  ) {
    return {
      current: false,
      reason: "NO_DEPENDENCIES",
      changedFiles: [],
    };
  }

  const current =
    await readCurrentDependencyChecksums(
      admin,
      theme,
      map.dependencies,
    );

  const changedFiles:
    string[] = [];

  let missingChanged =
    false;

  for (
    const dependency
    of map.dependencies
  ) {
    const normalized =
      normalizeFilename(
        dependency.filename,
      );

    const currentChecksum =
      current.get(
        normalized,
      ) ??
      "MISSING";

    if (
      currentChecksum !==
      dependency.checksum
    ) {
      changedFiles.push(
        dependency.filename,
      );

      if (
        currentChecksum ===
          "MISSING" ||
        dependency.checksum ===
          "MISSING"
      ) {
        missingChanged =
          true;
      }
    }
  }

  if (
    changedFiles.length > 0
  ) {
    return {
      current: false,

      reason:
        missingChanged
          ? "DEPENDENCY_MISSING"
          : "DEPENDENCY_CHANGED",

      changedFiles,
    };
  }

  return {
    current: true,
    reason: "CURRENT",
    changedFiles: [],
  };
}

async function persistAndCacheCompiledMap(
  options: {
    admin: AdminGraphqlClient;
    shop: string;
    theme: ActiveTheme;
  },
): Promise<ThemeMapV4> {
  const map =
    await buildThemeMapV4ForTheme(
      options.admin,
      options.theme,
    );

  /**
   * A theme can be published/edited while the compiler is reading files.
   * Confirm identity again before persisting.
   */
  const confirmedTheme =
    await getActiveTheme(
      options.admin,
    );

  if (
    confirmedTheme.id !==
    options.theme.id
  ) {
    throw new Error(
      "ACTIVE_THEME_CHANGED_DURING_V4_COMPILE",
    );
  }

  if (
    themeVersionKey(
      confirmedTheme,
    ) !==
    themeVersionKey(
      options.theme,
    )
  ) {
    throw new Error(
      "ACTIVE_THEME_UPDATED_DURING_V4_COMPILE",
    );
  }

  if (
    !mapMatchesTheme(
      map,
      confirmedTheme,
    )
  ) {
    throw new Error(
      "THEME_MAP_V4_IDENTITY_MISMATCH",
    );
  }

  /**
   * DB is the persistent source of truth.
   *
   * Do not serve a freshly compiled map if it cannot be persisted.
   * This prevents the app from silently falling back to RAM-only behavior.
   */
  await saveStoredThemeMapV4({
    shop: options.shop,
    themeGid:
      confirmedTheme.id,
    themeId:
      map.theme.id,
    themeName:
      map.theme.name,
    themeVersionKey:
      themeVersionKey(
        confirmedTheme,
      ),
    map,
    sourceMode:
      "COMPILER",
  });

  setRamCache({
    shop: options.shop,
    theme:
      confirmedTheme,
    map,
  });

  console.log(
    "[AI Search][Theme Map V4] compiled and persisted:",
    {
      shop:
        options.shop,

      themeId:
        map.theme.id,

      themeName:
        map.theme.name,

      status:
        map.status,

      fingerprint:
        map.fingerprint,

      dependencies:
        map.dependencies.length,

      candidates:
        map.rendererCandidates.length,

      eligibleCandidates:
        map.rendererCandidates.filter(
          (candidate) =>
            candidate.status ===
              "ELIGIBLE" &&
            candidate.mount != null,
        ).length,

      unsupportedReason:
        map.status ===
        "UNSUPPORTED"
          ? map.unsupportedReason
          : undefined,
    },
  );

  return map;
}

async function tryReuseRamMap(args: {
  admin: AdminGraphqlClient;
  shop: string;
  theme: ActiveTheme;
}): Promise<ThemeMapV4 | null> {
  const key =
    cacheKey(
      args.shop,
    );

  const existing =
    cache.get(
      key,
    );

  if (!existing) {
    return null;
  }

  if (
    existing.themeGid !==
      args.theme.id ||
    !mapMatchesTheme(
      existing.map,
      args.theme,
    )
  ) {
    cache.delete(
      key,
    );

    return null;
  }

  const currentVersion =
    themeVersionKey(
      args.theme,
    );

  /**
   * Exact same Shopify theme snapshot:
   * zero dependency API reads, zero compile.
   */
  if (
    existing.themeVersionKey ===
    currentVersion
  ) {
    return existing.map;
  }

  const currentCheck =
    await isThemeMapV4Current(
      args.admin,
      args.theme,
      existing.map,
    );

  if (
    !currentCheck.current
  ) {
    console.log(
      "[AI Search][Theme Map V4] RAM map stale:",
      {
        shop:
          args.shop,

        reason:
          currentCheck.reason,

        changedFiles:
          currentCheck.changedFiles,
      },
    );

    cache.delete(
      key,
    );

    return null;
  }

  existing.themeVersionKey =
    currentVersion;

  existing.cachedAt =
    Date.now();

  cache.set(
    key,
    existing,
  );

  /**
   * Persist the validated snapshot version too.
   * This means a later server restart can reuse DB without recompiling.
   */
  await refreshStoredThemeMapV4Version({
    shop:
      args.shop,

    themeId:
      existing.map.theme.id,

    themeGid:
      args.theme.id,

    themeVersionKey:
      currentVersion,

    fingerprint:
      existing.map.fingerprint,

    mapStatus:
      existing.map.status,
  });

  return existing.map;
}

async function tryReusePersistentMap(args: {
  admin: AdminGraphqlClient;
  shop: string;
  theme: ActiveTheme;
}): Promise<ThemeMapV4 | null> {
  const stored =
    await loadStoredThemeMapV4({
      shop:
        args.shop,

      themeId:
        numericThemeId(
          args.theme.id,
        ),
    });

  if (!stored) {
    return null;
  }

  if (
    !mapMatchesTheme(
      stored.map,
      args.theme,
    )
  ) {
    return null;
  }

  const currentVersion =
    themeVersionKey(
      args.theme,
    );

  /**
   * Server restart path:
   *
   * RAM empty
   * → DB hit
   * → exact same theme snapshot
   * → reuse immediately
   * → NO COMPILE.
   *
   * UNSUPPORTED maps are also reused here so a theme that the compiler could
   * not support does not trigger repeated expensive rebuilds every search.
   */
  if (
    stored.themeVersionKey ===
    currentVersion
  ) {
    setRamCache({
      shop:
        args.shop,

      theme:
        args.theme,

      map:
        stored.map,
    });

    void touchStoredThemeMapV4Usage({
      shop:
        args.shop,

      themeId:
        stored.themeId,

      fingerprint:
        stored.fingerprint,
    }).catch(
      (error) => {
        console.warn(
          "[AI Search][Theme Map V4] lastUsedAt update failed:",
          error,
        );
      },
    );

    console.log(
      "[AI Search][Theme Map V4] loaded from persistent DB:",
      {
        shop:
          args.shop,

        themeId:
          stored.themeId,

        status:
          stored.map.status,

        fingerprint:
          stored.map.fingerprint,
      },
    );

    return stored.map;
  }

  /**
   * Theme snapshot changed.
   *
   * This still does NOT compile.
   * First verify only the dependencies that generated the stored map.
   */
  const currentCheck =
    await isThemeMapV4Current(
      args.admin,
      args.theme,
      stored.map,
    );

  if (
    !currentCheck.current
  ) {
    console.log(
      "[AI Search][Theme Map V4] persisted map stale:",
      {
        shop:
          args.shop,

        themeId:
          stored.themeId,

        reason:
          currentCheck.reason,

        changedFiles:
          currentCheck.changedFiles,
      },
    );

    return null;
  }

  await refreshStoredThemeMapV4Version({
    shop:
      args.shop,

    themeId:
      stored.themeId,

    themeGid:
      args.theme.id,

    themeVersionKey:
      currentVersion,

    fingerprint:
      stored.fingerprint,

    mapStatus:
      stored.map.status,
  });

  setRamCache({
    shop:
      args.shop,

    theme:
      args.theme,

    map:
      stored.map,
  });

  console.log(
    "[AI Search][Theme Map V4] theme snapshot changed but renderer dependencies are unchanged; DB map reused:",
    {
      shop:
        args.shop,

      themeId:
        stored.themeId,

      fingerprint:
        stored.fingerprint,
    },
  );

  return stored.map;
}

/**
 * Main V4 lifecycle.
 *
 * Order:
 *
 * RAM
 *  ↓ miss
 * persistent DB
 *  ↓ miss/stale
 * compiler
 *  ↓
 * persistent DB
 *  ↓
 * RAM
 *
 * Server restart therefore does not cause recompilation when the stored map
 * belongs to the same MAIN theme snapshot.
 */
export async function getActiveThemeMapV4(
  options: GetActiveThemeMapV4Options,
): Promise<ThemeMapV4> {
  const theme =
    options.activeTheme ??
    await getActiveTheme(
      options.admin,
    );

  if (
    theme.processing ||
    theme.processingFailed
  ) {
    throw new Error(
      "THEME_PROCESSING",
    );
  }

  if (
    !options.forceRebuild
  ) {
    const ramMap =
      await tryReuseRamMap({
        admin:
          options.admin,

        shop:
          options.shop,

        theme,
      });

    if (ramMap) {
      return ramMap;
    }

    const persistentMap =
      await tryReusePersistentMap({
        admin:
          options.admin,

        shop:
          options.shop,

        theme,
      });

    if (persistentMap) {
      return persistentMap;
    }
  }

  const flightKey =
    buildInFlightKey(
      options.shop,
      theme,
    );

  const pending =
    inFlight.get(
      flightKey,
    );

  if (pending) {
    return pending;
  }

  const buildPromise =
    persistAndCacheCompiledMap({
      admin:
        options.admin,

      shop:
        options.shop,

      theme,
    })
      .catch(
        async (
          error,
        ) => {
          if (
            error instanceof
              Error &&
            (
              error.message ===
                "ACTIVE_THEME_CHANGED_DURING_V4_COMPILE" ||
              error.message ===
                "ACTIVE_THEME_UPDATED_DURING_V4_COMPILE"
            )
          ) {
            const refreshed =
              await getActiveTheme(
                options.admin,
              );

            return persistAndCacheCompiledMap({
              admin:
                options.admin,

              shop:
                options.shop,

              theme:
                refreshed,
            });
          }

          throw error;
        },
      )
      .finally(
        () => {
          inFlight.delete(
            flightKey,
          );
        },
      );

  inFlight.set(
    flightKey,
    buildPromise,
  );

  return buildPromise;
}

/**
 * Manual/admin rebuild.
 *
 * Old VERIFIED data remains preserved in the DB verified* backup fields if
 * this rebuild produces an UNSUPPORTED map.
 */
export async function rebuildActiveThemeMapV4(
  options: {
    admin: AdminGraphqlClient;
    shop: string;
  },
): Promise<ThemeMapV4> {
  return getActiveThemeMapV4({
    ...options,
    forceRebuild: true,
  });
}

/**
 * RAM only.
 *
 * Persistent DB remains intact, so the next request reloads the stored V4 map
 * instead of recompiling.
 */
export function invalidateThemeMapV4(
  shop: string,
): void {
  cache.delete(
    cacheKey(
      shop,
    ),
  );
}

/**
 * Test/process helper. Persistent DB is intentionally untouched.
 */
export function clearThemeMapV4Cache(): void {
  cache.clear();
  inFlight.clear();
}

export function peekThemeMapV4Cache(
  shop: string,
):
  | {
      themeGid: string;
      themeVersionKey: string;
      cachedAt: number;
      status: ThemeMapV4["status"];
      fingerprint: string;
    }
  | null {
  const entry =
    cache.get(
      cacheKey(
        shop,
      ),
    );

  if (!entry) {
    return null;
  }

  return {
    themeGid:
      entry.themeGid,

    themeVersionKey:
      entry.themeVersionKey,

    cachedAt:
      entry.cachedAt,

    status:
      entry.map.status,

    fingerprint:
      entry.map.fingerprint,
  };
}
