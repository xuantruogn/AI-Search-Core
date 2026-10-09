import db from "../../db.server";
import { getShopEntitlement } from "../commerce/entitlement.server";
import { PRODUCT_ENRICHMENT_VERSION } from "../products/product-embedding-input.server";
import { PRODUCT_EMBEDDING_PIPELINE_VERSION } from "../products/product-index-version.server";

export function resolveCatalogIndexLanguage(snapshot: string | null | undefined, state: { pendingCatalogLanguage: string | null; searchLanguage: string | null }) {
  return snapshot !== undefined ? snapshot : state.pendingCatalogLanguage ?? state.searchLanguage;
}

export async function readCatalogLanguageState(shop: string) {
  const rows = await db.$queryRaw<Array<{ searchLanguage: string | null; pendingCatalogLanguage: string | null; catalogLanguageVerifiedAt: Date | null }>>`
    SELECT searchLanguage, pendingCatalogLanguage, catalogLanguageVerifiedAt FROM AiSearchShopSettings WHERE shop = ${shop} LIMIT 1
  `;
  return rows[0] ?? { searchLanguage: null, pendingCatalogLanguage: null, catalogLanguageVerifiedAt: null };
}

/** Single-index rebuild: hide the mixed index until a complete validated scan.
 * No vector is deleted. Failed/blocked rebuilds remain pending and fail open. */
export async function sampleCatalogSourceLanguage(shop: string) {
  const rows = await db.$queryRaw<Array<{ sourceLanguage: string | null }>>`
    SELECT JSON_UNQUOTE(JSON_EXTRACT(profile, '$.meta.sourceLanguage')) AS sourceLanguage
    FROM AiSearchProductSemanticProfile WHERE shop = ${shop} ORDER BY id LIMIT 100
  `;
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.sourceLanguage) continue;
    try {
      const code = Intl.getCanonicalLocales(row.sourceLanguage)[0]?.split("-")[0].toLowerCase();
      if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
    } catch { /* Unrecognized legacy language metadata is not evidence. */ }
  }
  const known = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const strongest = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return { sampled: rows.length, known, dominant: known >= 20 && strongest && strongest[1] / known >= .8 ? strongest[0] : null };
}

export async function requestCatalogLanguageChange(shop: string, language: string, acknowledgeMismatch = false) {
  const source = await sampleCatalogSourceLanguage(shop);
  if (source.dominant && source.dominant !== language.split("-")[0].toLowerCase() && !acknowledgeMismatch) {
    throw new Error(`Existing product language evidence indicates ${source.dominant}. Confirm the mismatch explicitly before rebuilding. This sample is not a definitive language detector.`);
  }
  const entitlement = await getShopEntitlement(shop);
  if (!entitlement.active) throw new Error("Activate a subscription before requesting a catalog language rebuild.");
  return db.$transaction(async (tx) => {
    const settings = await tx.$queryRaw<Array<{ searchLanguage: string | null; pendingCatalogLanguage: string | null }>>`
      SELECT searchLanguage, pendingCatalogLanguage FROM AiSearchShopSettings WHERE shop = ${shop} FOR UPDATE
    `;
    if (!settings[0]) throw new Error("Catalog language settings missing.");
    const busy = await tx.$queryRaw<Array<{ id: number }>>`
      SELECT id FROM AiSearchCatalogSyncJob WHERE shop = ${shop} AND status IN ('PENDING', 'PROCESSING') LIMIT 1 FOR UPDATE
    `;
    if (busy.length) throw new Error("Wait for the current catalog sync to finish before changing catalog language.");
    if (settings[0].pendingCatalogLanguage && settings[0].pendingCatalogLanguage.toLowerCase() !== language.toLowerCase()) {
      throw new Error("Finish the pending language rebuild before choosing another catalog language.");
    }
    await tx.$executeRaw`
      INSERT INTO AiSearchCatalogSyncJob (shop, reason, planAtStart, languageAtStart, status, createdAt, updatedAt)
      VALUES (${shop}, 'LANGUAGE_CHANGE', ${entitlement.plan}, ${language}, 'PENDING', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
    `;
    await tx.$executeRaw`
      UPDATE AiSearchShopSettings SET pendingCatalogLanguage = ${language}, updatedAt = UTC_TIMESTAMP(3),
        catalogRevision = catalogRevision + 1, semanticRevision = semanticRevision + 1 WHERE shop = ${shop}
    `;
    return language;
  });
}

export async function activateCompletedCatalogLanguage(jobId: number) {
  return db.$transaction(async (tx) => {
    const jobs = await tx.$queryRaw<Array<{ shop: string; languageAtStart: string | null; productsFailed: number; productsBlocked: number }>>`
      SELECT shop, languageAtStart, productsFailed, productsBlocked FROM AiSearchCatalogSyncJob
      WHERE id = ${jobId} AND status = 'DONE' AND reason = 'LANGUAGE_CHANGE'
    `;
    const job = jobs[0];
    if (!job?.languageAtStart || job.productsFailed > 0) return false;
    // Only searchable retained vectors participate. Over-limit/inactive products
    // keep their vectors but cannot be published until rebuilt on recovery.
    const blocked = await tx.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) AS count FROM AiSearchIndexedProduct WHERE shop = ${job.shop}
        AND (blockedReason IN ('VECTOR_UPDATE_LIMIT', 'SUBSCRIPTION_INACTIVE') OR status = 'STAGING')
    `;
    if (Number(blocked[0]?.count ?? 0) > 0) return false;
    const stale = await tx.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) AS count FROM AiSearchIndexedProduct WHERE shop = ${job.shop} AND searchable = true AND hasVector = true
      AND (catalogLanguage IS NULL OR catalogLanguage <> ${job.languageAtStart}
        OR enrichmentVersion IS NULL OR enrichmentVersion <> ${PRODUCT_ENRICHMENT_VERSION}
        OR embeddingPipelineVersion IS NULL OR embeddingPipelineVersion <> ${PRODUCT_EMBEDDING_PIPELINE_VERSION})
    `;
    if (Number(stale[0]?.count ?? 0) > 0) return false;
    const changed = await tx.$executeRaw`
      UPDATE AiSearchShopSettings SET searchLanguage = ${job.languageAtStart}, pendingCatalogLanguage = NULL,
        catalogLanguageVerifiedAt = UTC_TIMESTAMP(3),
        catalogRevision = catalogRevision + 1, semanticRevision = semanticRevision + 1, updatedAt = UTC_TIMESTAMP(3)
      WHERE shop = ${job.shop} AND pendingCatalogLanguage = ${job.languageAtStart}
    `;
    return changed === 1;
  });
}

export async function catalogLanguageProofCompatible(shop: string) {
  const state = await readCatalogLanguageState(shop);
  if (state.pendingCatalogLanguage || !state.searchLanguage) return false;
  const stale = await db.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*) AS count FROM AiSearchIndexedProduct WHERE shop = ${shop} AND searchable = true AND hasVector = true
      AND (catalogLanguage IS NULL OR catalogLanguage <> ${state.searchLanguage}
        OR enrichmentVersion IS NULL OR enrichmentVersion <> ${PRODUCT_ENRICHMENT_VERSION}
        OR embeddingPipelineVersion IS NULL OR embeddingPipelineVersion <> ${PRODUCT_EMBEDDING_PIPELINE_VERSION})
  `;
  return Number(stale[0]?.count ?? 0) === 0;
}

/** Legacy stores remain usable but cannot prove absence without metadata.
 * Once a language rebuild was activated, every request requires a homogeneous
 * index, including recovery of retained previously-blocked vectors. */
export async function catalogLanguageSearchReady(shop: string) {
  const state = await readCatalogLanguageState(shop);
  if (state.pendingCatalogLanguage) return false;
  return !state.catalogLanguageVerifiedAt || await catalogLanguageProofCompatible(shop);
}
