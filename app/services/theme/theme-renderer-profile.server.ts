import { createHash } from "node:crypto";

import {
  analyzeSnippetCompatibility,
  compileSearchRendererCandidates,
  compileStandaloneSnippetRenderer,
  type RendererProfile,
} from "./theme-compiler.server";
import {
  getActiveTheme,
  getThemeFilesByPatterns,
  type ActiveTheme,
  type ThemeFile,
} from "./theme-reader.server";
import {
  findTemplateSectionSettings,
  parseGlobalThemeSettings,
  resolveRenderArguments,
  type ThemeSectionSettings,
} from "./theme-settings-resolver.server";

type AdminGraphqlClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

type ResolvedArguments = Record<string, string | number | boolean | null>;

export type CompiledThemeRenderer = {
  rendererId: string;
  themeId: string;
  themeName: string;
  themeUpdatedAt: string;
  themeVersionKey: string;
  themeFingerprint: string;
  sourceFile: string;
  templateFile: string | null;
  profile: RendererProfile;
  resolvedArguments: ResolvedArguments;
  score: number;
};

type CatalogEntry = {
  expiresAt: number;
  themeId: string;
  themeName: string;
  themeUpdatedAt: string;
  themeVersionKey: string;
  themeFingerprint: string;
  candidates: CompiledThemeRenderer[];
  diagnostics: string[];
};

type RejectedCandidateEntry = {
  expiresAt: number;
};

const cacheGlobal = globalThis as typeof globalThis & {
  aiSearchThemeRendererCatalogCache?: Map<string, CatalogEntry>;
  aiSearchRejectedThemeRendererCandidates?: Map<string, RejectedCandidateEntry>;
  aiSearchThemeRendererCatalogBuilds?: Map<string, Promise<CatalogEntry>>;
  aiSearchThemeRendererCacheEpochs?: Map<string, number>;
};

const catalogCache =
  cacheGlobal.aiSearchThemeRendererCatalogCache ??
  (cacheGlobal.aiSearchThemeRendererCatalogCache = new Map());

const rejectedCandidates =
  cacheGlobal.aiSearchRejectedThemeRendererCandidates ??
  (cacheGlobal.aiSearchRejectedThemeRendererCandidates = new Map());

const catalogBuilds =
  cacheGlobal.aiSearchThemeRendererCatalogBuilds ??
  (cacheGlobal.aiSearchThemeRendererCatalogBuilds = new Map());

const cacheEpochs =
  cacheGlobal.aiSearchThemeRendererCacheEpochs ??
  (cacheGlobal.aiSearchThemeRendererCacheEpochs = new Map());

function cacheEpoch(shop: string) {
  return cacheEpochs.get(shop) ?? 0;
}

function readPositiveInteger(name: string, fallback: number) {
  const raw = Number.parseInt(process.env[name] || "", 10);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : fallback;
}

const CACHE_TTL_MS = readPositiveInteger(
  "AI_SEARCH_THEME_RENDERER_CACHE_MS",
  5 * 60_000,
);

const REJECTED_CANDIDATE_TTL_MS = readPositiveInteger(
  "AI_SEARCH_THEME_RENDERER_REJECT_MS",
  5 * 60_000,
);

const DISCOVERY_MAX_FILES = Math.min(
  readPositiveInteger("AI_SEARCH_THEME_DISCOVERY_MAX_FILES", 1_000),
  2_500,
);

// These are Shopify theme structure directories, not theme-specific filenames.
// The bridge asks Shopify for what actually exists under each structure and
// compiles every product-card invocation it can prove from source.
const THEME_DISCOVERY_PATTERNS = [
  "sections/*.liquid",
  "snippets/*.liquid",
  "blocks/*.liquid",
  "templates/*.liquid",
  "templates/*.json",
  "config/settings_data.json",
] as const;

function rejectedCandidateKey(
  shop: string,
  themeVersionKey: string,
  rendererId: string,
) {
  return `${shop}\u0000${themeVersionKey}\u0000${rendererId}`;
}

function isCandidateRejected(
  shop: string,
  themeVersionKey: string,
  rendererId: string,
) {
  const key = rejectedCandidateKey(shop, themeVersionKey, rendererId);
  const entry = rejectedCandidates.get(key);
  if (!entry) return false;

  if (entry.expiresAt <= Date.now()) {
    rejectedCandidates.delete(key);
    return false;
  }

  return true;
}

function sectionTypeFromSourceFile(filename: string): string | null {
  const match = filename.match(/^sections\/(.+)\.liquid$/i);
  return match?.[1] ?? null;
}

function sourceStructureBonus(filename: string) {
  if (filename.startsWith("sections/")) return 6;
  if (filename.startsWith("templates/")) return 4;
  if (filename.startsWith("blocks/")) return 3;
  if (filename.startsWith("snippets/")) return 1;
  return 0;
}

function sourceProvesProductRenderer(profile: RendererProfile) {
  const signals = new Set(profile.signals);
  return (
    signals.has("search-context") ||
    signals.has("collection-products-context") ||
    signals.has("recommendations-context") ||
    signals.has("predictive-search-context") ||
    signals.has("products-iterable") ||
    signals.has("static-product-resource-type") ||
    signals.has("standalone-snippet")
  );
}

function targetProvesCardLikeRendering(signals: string[]) {
  const set = new Set(signals);
  const hasLink = set.has("renders-link") || set.has("uses-resource-url");
  const hasContent =
    set.has("renders-media") ||
    set.has("uses-resource-media") ||
    set.has("uses-resource-title") ||
    set.has("renders-price");
  return hasLink && hasContent;
}

function targetSnippetFilename(profile: RendererProfile) {
  return profile.cardSnippet ? `snippets/${profile.cardSnippet}.liquid` : null;
}

function missingRequiredSnippetArguments({
  targetContent,
  profile,
  resolvedArguments,
}: {
  targetContent: string;
  profile: RendererProfile;
  resolvedArguments: ResolvedArguments;
}) {
  const compatibility = analyzeSnippetCompatibility(targetContent);
  const satisfied = new Set(Object.keys(resolvedArguments));
  if (profile.productArgument) satisfied.add(profile.productArgument);
  if (profile.implicitProductVariable) satisfied.add(profile.implicitProductVariable);

  return {
    compatibility,
    missing: compatibility.requiredParameters.filter(
      (parameter) => !satisfied.has(parameter),
    ),
  };
}

function templatePriority(filename: string, profile: RendererProfile) {
  let priority = 0;
  const signals = new Set(profile.signals);

  // search/collection are Shopify template types, not merchant/theme naming
  // guesses. Prefer the template type whose source context proved the card use.
  if (
    signals.has("search-context") &&
    /^templates\/search(?:\.[^/]+)?\.json$/i.test(filename)
  ) {
    priority += 100;
  }

  if (
    signals.has("collection-products-context") &&
    /^templates\/collection(?:\.[^/]+)?\.json$/i.test(filename)
  ) {
    priority += 80;
  }

  return priority;
}

function findSettingsForSection({
  templates,
  sectionType,
  profile,
  diagnostics,
}: {
  templates: ThemeFile[];
  sectionType: string | null;
  profile: RendererProfile;
  diagnostics: string[];
}): {
  settings: ThemeSectionSettings;
  templateFile: string | null;
} {
  if (!sectionType) return { settings: {}, templateFile: null };

  const orderedTemplates = [...templates].sort(
    (a, b) =>
      templatePriority(b.filename, profile) -
        templatePriority(a.filename, profile) ||
      a.filename.localeCompare(b.filename),
  );

  for (const template of orderedTemplates) {
    try {
      const match = findTemplateSectionSettings(template.content, [sectionType]);
      if (match.found) {
        return {
          settings: match.settings,
          templateFile: template.filename,
        };
      }
    } catch (error) {
      diagnostics.push(
        `${template.filename}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { settings: {}, templateFile: null };
}

function themeFilesFingerprint(files: Map<string, ThemeFile>) {
  const hash = createHash("sha256");
  for (const file of [...files.values()].sort((a, b) =>
    a.filename.localeCompare(b.filename),
  )) {
    hash.update(file.filename);
    hash.update("\0");
    hash.update(file.checksumMd5 ?? file.updatedAt ?? file.content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function assertThemeReady(theme: ActiveTheme) {
  if (theme.processing || theme.processingFailed) {
    throw new Error(
      `Active theme ${theme.name} is not ready (processing=${theme.processing}, processingFailed=${theme.processingFailed})`,
    );
  }
}

async function discoverRendererCatalog({
  admin,
  shop,
  theme,
}: {
  admin: AdminGraphqlClient;
  shop: string;
  theme: ActiveTheme;
}): Promise<CatalogEntry> {
  assertThemeReady(theme);
  const files = await getThemeFilesByPatterns(
    admin,
    theme.id,
    [...THEME_DISCOVERY_PATTERNS],
    { maxFiles: DISCOVERY_MAX_FILES },
  );

  const diagnostics: string[] = [];
  const themeFingerprint = themeFilesFingerprint(files);
  const liquidSources = [...files.values()].filter((file) =>
    file.filename.endsWith(".liquid"),
  );
  const templates = [...files.values()].filter(
    (file) =>
      file.filename.startsWith("templates/") && file.filename.endsWith(".json"),
  );

  let globalSettings: ThemeSectionSettings = {};
  const settingsData = files.get("config/settings_data.json");
  if (settingsData) {
    try {
      globalSettings = parseGlobalThemeSettings(settingsData.content);
    } catch (error) {
      diagnostics.push(
        `config/settings_data.json: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const compiled: CompiledThemeRenderer[] = [];

  for (const source of liquidSources) {
    const invocationCandidates = compileSearchRendererCandidates(source.content);
    const standaloneCandidate = compileStandaloneSnippetRenderer(
      source.filename,
      source.content,
    );
    const sourceCandidates = standaloneCandidate
      ? [...invocationCandidates, standaloneCandidate]
      : invocationCandidates;
    if (sourceCandidates.length === 0) continue;

    const sectionType = sectionTypeFromSourceFile(source.filename);

    for (const candidate of sourceCandidates) {
      const settingsMatch = findSettingsForSection({
        templates,
        sectionType,
        profile: candidate.profile,
        diagnostics,
      });

      const resolvedArguments = resolveRenderArguments(
        candidate.profile.renderArguments,
        settingsMatch.settings,
        globalSettings,
      );

      // Inspect the actual target snippet before declaring an invocation
      // usable. Modern themes can expose a product-looking call that depends
      // on `block`, `section`, `content_for`, or captured `children`. Those
      // locals do not exist in an App Proxy render and must not be guessed.
      const targetFilename = targetSnippetFilename(candidate.profile);
      const target = targetFilename ? files.get(targetFilename) : null;
      let compatibilityBonus = 0;

      if (target) {
        const { compatibility, missing } = missingRequiredSnippetArguments({
          targetContent: target.content,
          profile: candidate.profile,
          resolvedArguments,
        });

        if (compatibility.hardContextDependencies.length > 0) {
          diagnostics.push(
            `${source.filename} -> ${target.filename}: rejected; requires ` +
              compatibility.hardContextDependencies.join(", "),
          );
          continue;
        }

        if (missing.length > 0) {
          diagnostics.push(
            `${source.filename} -> ${target.filename}: rejected; unresolved required params ` +
              missing.join(", "),
          );
          continue;
        }

        const targetCardEvidence = targetProvesCardLikeRendering(
          compatibility.signals,
        );
        if (!targetCardEvidence) {
          diagnostics.push(
            `${source.filename} -> ${target.filename}: rejected; target snippet does not prove card-like link/content rendering`,
          );
          continue;
        }

        compatibilityBonus += 8;
      } else if (targetFilename) {
        // If discovery hit its file cap, a strongly proven product-list source
        // can still be attempted. A weak name/argument-only candidate must not
        // bypass target validation just because its snippet body was missing.
        if (!sourceProvesProductRenderer(candidate.profile)) {
          diagnostics.push(
            `${source.filename}: rejected; target ${targetFilename} unavailable and source lacks product-list capability proof`,
          );
          continue;
        }

        compatibilityBonus -= 2;
        diagnostics.push(
          `${source.filename}: target ${targetFilename} was not available for compatibility validation`,
        );
      }

      const rendererId = `${source.filename}|${candidate.signature}`;
      const score =
        candidate.profile.score +
        sourceStructureBonus(source.filename) +
        compatibilityBonus;

      compiled.push({
        rendererId,
        themeId: theme.id,
        themeName: theme.name,
        themeUpdatedAt: theme.updatedAt,
        themeVersionKey: theme.versionKey,
        themeFingerprint,
        sourceFile: source.filename,
        templateFile: settingsMatch.templateFile,
        profile: candidate.profile,
        resolvedArguments,
        score,
      });
    }
  }

  const deduped = new Map<string, CompiledThemeRenderer>();
  for (const candidate of compiled) {
    const existing = deduped.get(candidate.rendererId);
    if (!existing || candidate.score > existing.score) {
      deduped.set(candidate.rendererId, candidate);
    }
  }

  const candidates = [...deduped.values()].sort(
    (a, b) =>
      b.score - a.score ||
      a.sourceFile.localeCompare(b.sourceFile) ||
      a.rendererId.localeCompare(b.rendererId),
  );

  if (candidates.length === 0) {
    diagnostics.push(
      `scanned ${liquidSources.length} Liquid files and ${templates.length} JSON templates; no product-card invocation passed compatibility checks`,
    );
  }

  const catalog: CatalogEntry = {
    expiresAt: Date.now() + CACHE_TTL_MS,
    themeId: theme.id,
    themeName: theme.name,
    themeUpdatedAt: theme.updatedAt,
    themeVersionKey: theme.versionKey,
    themeFingerprint,
    candidates,
    diagnostics,
  };

  console.log("[AI Search] Theme renderer catalog compiled:", {
    shop,
    theme: theme.name,
    themeUpdatedAt: theme.updatedAt,
    themeFingerprint,
    filesRead: files.size,
    liquidFilesScanned: liquidSources.length,
    templatesScanned: templates.length,
    rendererCandidates: candidates.length,
    topCandidates: candidates.slice(0, 5).map((candidate) => ({
      sourceFile: candidate.sourceFile,
      snippet: candidate.profile.cardSnippet,
      invocationTag: candidate.profile.invocationTag,
      score: candidate.score,
      signals: candidate.profile.signals,
    })),
  });

  return catalog;
}

function purgeRejectedCandidatesForShop(shop: string) {
  const prefix = `${shop}\u0000`;
  for (const key of rejectedCandidates.keys()) {
    if (key.startsWith(prefix)) rejectedCandidates.delete(key);
  }
}

async function buildCatalogForTheme({
  admin,
  shop,
  theme,
}: {
  admin: AdminGraphqlClient;
  shop: string;
  theme: ActiveTheme;
}) {
  const buildEpoch = cacheEpoch(shop);
  const buildKey = `${shop}\u0000${theme.versionKey}\u0000${buildEpoch}`;
  const existingBuild = catalogBuilds.get(buildKey);
  if (existingBuild) return existingBuild;

  // Capture the invalidation generation before source discovery. A publish or
  // active-theme update can arrive while an expensive catalog is compiling;
  // that obsolete build may finish, but it must never repopulate the cache.
  const build = discoverRendererCatalog({ admin, shop, theme })
    .then((catalog) => {
      if (cacheEpoch(shop) === buildEpoch) {
        catalogCache.set(shop, catalog);
      }
      return catalog;
    })
    .finally(() => {
      catalogBuilds.delete(buildKey);
    });
  catalogBuilds.set(buildKey, build);
  return build;
}

async function getRendererCatalog({
  admin,
  shop,
  activeTheme,
}: {
  admin: AdminGraphqlClient;
  shop: string;
  activeTheme?: ActiveTheme;
}) {
  // This identity check is intentionally performed before every AI search.
  // It is cheap compared with source discovery and prevents a stale renderer
  // from surviving theme A -> B, B -> A, or an edit of the same live theme.
  let theme = activeTheme ?? (await getActiveTheme(admin));

  // A theme publish/update webhook can race a source scan. Retry a bounded
  // number of times and only return a catalog when both the MAIN theme version
  // and the local invalidation generation stayed stable for the whole build.
  // If the store keeps changing, the caller safely falls back before OpenAI.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assertThemeReady(theme);

    const cached = catalogCache.get(shop);
    if (
      cached &&
      cached.expiresAt > Date.now() &&
      cached.themeVersionKey === theme.versionKey
    ) {
      return cached;
    }

    if (cached && cached.themeVersionKey !== theme.versionKey) {
      invalidateThemeRendererCache(shop);
      console.log("[AI Search] Active theme version changed; renderer cache invalidated:", {
        shop,
        previousThemeId: cached.themeId,
        previousThemeUpdatedAt: cached.themeUpdatedAt,
        currentThemeId: theme.id,
        currentThemeUpdatedAt: theme.updatedAt,
      });
    }

    const buildEpoch = cacheEpoch(shop);
    const catalog = await buildCatalogForTheme({ admin, shop, theme });
    const confirmedTheme = await getActiveTheme(admin);
    assertThemeReady(confirmedTheme);

    if (
      confirmedTheme.versionKey === theme.versionKey &&
      cacheEpoch(shop) === buildEpoch
    ) {
      return catalog;
    }

    // If a caller supplied a verified snapshot, never silently switch its
    // renderer to another theme. The caller must re-check App Embed state for
    // that new MAIN theme before it can spend an embedding.
    if (activeTheme) {
      throw new Error("ACTIVE_THEME_CHANGED_DURING_RENDERER_PREFLIGHT");
    }

    if (cacheEpoch(shop) === buildEpoch) {
      invalidateThemeRendererCache(shop);
    }
    theme = confirmedTheme;
  }

  throw new Error("ACTIVE_THEME_DID_NOT_STABILIZE_DURING_RENDERER_PREFLIGHT");
}

export function invalidateThemeRendererCache(shop: string) {
  catalogCache.delete(shop);
  purgeRejectedCandidatesForShop(shop);
  cacheEpochs.set(shop, cacheEpoch(shop) + 1);

  // Promises can't be cancelled, but removing their dedupe entries lets the
  // next request build from the newly confirmed active theme immediately.
  const prefix = `${shop}\u0000`;
  for (const key of catalogBuilds.keys()) {
    if (key.startsWith(prefix)) catalogBuilds.delete(key);
  }
}

export function rejectThemeRendererCandidate({
  shop,
  themeVersionKey,
  rendererId,
}: {
  shop: string;
  themeVersionKey: string;
  rendererId: string;
}) {
  rejectedCandidates.set(
    rejectedCandidateKey(shop, themeVersionKey, rendererId),
    { expiresAt: Date.now() + REJECTED_CANDIDATE_TTL_MS },
  );
}

export async function getCompiledThemeRenderer({
  admin,
  shop,
  activeTheme,
}: {
  admin: AdminGraphqlClient;
  shop: string;
  activeTheme?: ActiveTheme;
}): Promise<CompiledThemeRenderer> {
  const catalog = await getRendererCatalog({ admin, shop, activeTheme });

  for (const candidate of catalog.candidates) {
    if (
      isCandidateRejected(
        shop,
        catalog.themeVersionKey,
        candidate.rendererId,
      )
    ) {
      continue;
    }

    console.log("[AI Search] Theme renderer selected:", {
      shop,
      theme: catalog.themeName,
      themeUpdatedAt: catalog.themeUpdatedAt,
      themeFingerprint: catalog.themeFingerprint,
      sourceFile: candidate.sourceFile,
      snippet: candidate.profile.cardSnippet,
      invocationTag: candidate.profile.invocationTag,
      score: candidate.score,
    });

    return candidate;
  }

  throw new Error(
    `Compatible product-card renderer not detected for theme ${catalog.themeName}. ` +
      `${catalog.candidates.length} candidates discovered, but none are currently usable. ` +
      catalog.diagnostics.join("; "),
  );
}
