import db from "../../db.server";

import {
  THEME_MAP_V4_VERSION,
  type ThemeMapV4,
} from "./theme-map-v4.types";

export type ThemeMapV4SourceMode =
  | "COMPILER"
  | "COMPILER_OPENAI_RECOVERY";

export interface StoredThemeMapV4 {
  shop: string;
  themeId: string;
  themeGid: string;
  themeName: string | null;
  schemaVersion: number;
  mapStatus: ThemeMapV4["status"];
  sourceMode: ThemeMapV4SourceMode | string;
  themeVersionKey: string;
  fingerprint: string;
  map: ThemeMapV4;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastValidatedAt: Date | null;
  lastUsedAt: Date | null;
}

function normalizeShop(shop: string): string {
  return shop.trim().toLowerCase();
}

function numericThemeId(id: string): string {
  return (
    id.match(
      /^(?:gid:\/\/shopify\/OnlineStoreTheme\/)?(\d+)$/,
    )?.[1] ?? id
  );
}

function parseThemeMap(
  raw: string,
  expectedThemeId: string,
  expectedFingerprint: string,
): ThemeMapV4 | null {
  try {
    const value = JSON.parse(raw) as unknown;

    if (!value || typeof value !== "object") {
      return null;
    }

    const map = value as Partial<ThemeMapV4>;

    if (map.version !== THEME_MAP_V4_VERSION) {
      return null;
    }

    if (
      map.status !== "VERIFIED" &&
      map.status !== "UNSUPPORTED"
    ) {
      return null;
    }

    if (
      !map.theme ||
      typeof map.theme !== "object" ||
      String(map.theme.id) !== expectedThemeId
    ) {
      return null;
    }

    if (
      typeof map.fingerprint !== "string" ||
      map.fingerprint !== expectedFingerprint
    ) {
      return null;
    }

    if (!Array.isArray(map.dependencies)) {
      return null;
    }

    if (!Array.isArray(map.rendererCandidates)) {
      return null;
    }

    return map as ThemeMapV4;
  } catch {
    return null;
  }
}

export async function loadStoredThemeMapV4(args: {
  shop: string;
  themeId: string;
}): Promise<StoredThemeMapV4 | null> {
  const shop = normalizeShop(args.shop);
  const themeId = numericThemeId(args.themeId);

  const row = await db.aiSearchThemeMapV4.findUnique({
    where: {
      shop_themeId: {
        shop,
        themeId,
      },
    },
  });

  if (!row) {
    return null;
  }

  if (row.schemaVersion !== THEME_MAP_V4_VERSION) {
    return null;
  }

  const map = parseThemeMap(
    row.mapJson,
    themeId,
    row.fingerprint,
  );

  if (!map) {
    console.error(
      "[AI Search][Theme Map V4 Store] Invalid persisted map; ignoring row:",
      {
        shop,
        themeId,
        rowId: row.id,
      },
    );

    return null;
  }

  return {
    shop: row.shop,
    themeId: row.themeId,
    themeGid: row.themeGid,
    themeName: row.themeName,
    schemaVersion: row.schemaVersion,
    mapStatus: row.mapStatus as ThemeMapV4["status"],
    sourceMode: row.sourceMode,
    themeVersionKey: row.themeVersionKey,
    fingerprint: row.fingerprint,
    map,
    failureReason: row.failureReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastValidatedAt: row.lastValidatedAt,
    lastUsedAt: row.lastUsedAt,
  };
}

export async function saveStoredThemeMapV4(args: {
  shop: string;
  themeGid: string;
  themeId: string;
  themeName?: string | null;
  themeVersionKey: string;
  map: ThemeMapV4;
  sourceMode?: ThemeMapV4SourceMode;
}): Promise<void> {
  const shop = normalizeShop(args.shop);
  const themeId = numericThemeId(args.themeId);
  const now = new Date();

  if (String(args.map.theme.id) !== themeId) {
    throw new Error("THEME_MAP_V4_STORE_THEME_ID_MISMATCH");
  }

  if (args.map.version !== THEME_MAP_V4_VERSION) {
    throw new Error("THEME_MAP_V4_STORE_SCHEMA_VERSION_MISMATCH");
  }

  const mapJson = JSON.stringify(args.map);
  const dependenciesJson = JSON.stringify(args.map.dependencies);
  const sourceMode = args.sourceMode ?? "COMPILER";
  const failureReason =
    args.map.status === "UNSUPPORTED"
      ? args.map.unsupportedReason
      : null;

  const verifiedFields =
    args.map.status === "VERIFIED"
      ? {
          verifiedThemeVersionKey: args.themeVersionKey,
          verifiedFingerprint: args.map.fingerprint,
          verifiedMapJson: mapJson,
          verifiedDependenciesJson: dependenciesJson,
        }
      : {};

  await db.aiSearchThemeMapV4.upsert({
    where: {
      shop_themeId: {
        shop,
        themeId,
      },
    },

    create: {
      shop,
      themeId,
      themeGid: args.themeGid,
      themeName: args.themeName ?? args.map.theme.name ?? null,
      schemaVersion: THEME_MAP_V4_VERSION,
      mapStatus: args.map.status,
      sourceMode,
      themeVersionKey: args.themeVersionKey,
      fingerprint: args.map.fingerprint,
      mapJson,
      dependenciesJson,
      failureReason,

      verifiedThemeVersionKey:
        args.map.status === "VERIFIED"
          ? args.themeVersionKey
          : null,

      verifiedFingerprint:
        args.map.status === "VERIFIED"
          ? args.map.fingerprint
          : null,

      verifiedMapJson:
        args.map.status === "VERIFIED"
          ? mapJson
          : null,

      verifiedDependenciesJson:
        args.map.status === "VERIFIED"
          ? dependenciesJson
          : null,

      lastValidatedAt: now,
      lastUsedAt: now,
    },

    update: {
      themeGid: args.themeGid,
      themeName: args.themeName ?? args.map.theme.name ?? null,
      schemaVersion: THEME_MAP_V4_VERSION,
      mapStatus: args.map.status,
      sourceMode,
      themeVersionKey: args.themeVersionKey,
      fingerprint: args.map.fingerprint,
      mapJson,
      dependenciesJson,
      failureReason,
      lastValidatedAt: now,
      lastUsedAt: now,
      ...verifiedFields,
    },
  });
}

export async function refreshStoredThemeMapV4Version(args: {
  shop: string;
  themeId: string;
  themeGid: string;
  themeVersionKey: string;
  fingerprint: string;
  mapStatus: ThemeMapV4["status"];
}): Promise<void> {
  const shop = normalizeShop(args.shop);
  const themeId = numericThemeId(args.themeId);
  const now = new Date();

  const result = await db.aiSearchThemeMapV4.updateMany({
    where: {
      shop,
      themeId,
      fingerprint: args.fingerprint,
    },
    data: {
      themeGid: args.themeGid,
      themeVersionKey: args.themeVersionKey,
      lastValidatedAt: now,
      lastUsedAt: now,
      ...(args.mapStatus === "VERIFIED"
        ? {
            verifiedThemeVersionKey: args.themeVersionKey,
          }
        : {}),
    },
  });

  if (result.count === 0) {
    throw new Error("THEME_MAP_V4_STORE_REFRESH_CONFLICT");
  }
}

export async function touchStoredThemeMapV4Usage(args: {
  shop: string;
  themeId: string;
  fingerprint: string;
}): Promise<void> {
  const shop = normalizeShop(args.shop);
  const themeId = numericThemeId(args.themeId);

  await db.aiSearchThemeMapV4.updateMany({
    where: {
      shop,
      themeId,
      fingerprint: args.fingerprint,
    },
    data: {
      lastUsedAt: new Date(),
    },
  });
}

export async function deleteStoredThemeMapV4(args: {
  shop: string;
  themeId?: string;
}): Promise<number> {
  const shop = normalizeShop(args.shop);

  const result = await db.aiSearchThemeMapV4.deleteMany({
    where: {
      shop,
      ...(args.themeId
        ? {
            themeId: numericThemeId(args.themeId),
          }
        : {}),
    },
  });

  return result.count;
}
