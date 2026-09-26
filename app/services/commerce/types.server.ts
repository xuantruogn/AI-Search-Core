import type { AiSearchPlan, PlanLimits } from "./plans.server";

export type SubscriptionSnapshot = {
  shop: string;
  plan: AiSearchPlan;
  planId: string | null;
  planLabel: string;
  limits: PlanLimits;
  status: string;
  planHandle: string | null;
  shopifySubscriptionId: string | null;
  billingPeriodStart: Date | null;
  billingPeriodEnd: Date | null;
  source: string;
  lastSyncedAt: Date | null;
};

export type ShopSettingsSnapshot = {
  searchLanguage: string | null;
  shop: string;
  aiSearchEnabled: boolean;
  customDataModeEnabled: boolean;
  fallbackEnabled: boolean;
  productLimitOverride: number | null;
  searchLimitOverride: number | null;
  vectorUpdateLimitOverride: number | null;
  resultLimit: number;
};

export type UsageSnapshot = {
  id: number;
  shop: string;
  periodKey: string;
  periodStart: Date;
  periodEnd: Date;
  searchCount: number;
  vectorUpdateCount: number;
  productIndexCount: number;
  productDeleteCount: number;
  queryEmbeddingCount: number;
  productEmbeddingCount: number;
  fallbackCount: number;
  blockedSearchCount: number;
  blockedVectorCount: number;
};

export type EntitlementSnapshot = {
  shop: string;
  plan: AiSearchPlan;
  planLabel: string;
  subscriptionStatus: string;
  active: boolean;
  aiSearchEnabled: boolean;
  fallbackEnabled: boolean;
  limits: PlanLimits;
  usage: UsageSnapshot;
  indexedProducts: number;
  productSlotsUsed: number;
  catalogProductCount: number;
  cachedVectorCount: number;
  activeProductSlotsUsed: number;
  blockedProductCount: number;
  staleVectorCount: number;
  vectorQuotaBlockedProducts: number;
  productLimitBlockedProducts: number;
  cachedProductLimitBlockedProducts: number;
  subscriptionBlockedProducts: number;
  resultLimit: number;
  searchAllowed: boolean;
  vectorUpdateAllowed: boolean;
  productSlotAvailable: boolean;
  productLimitExceeded: boolean;
  catalogSyncStatus: string | null;
  disabledReason: string | null;
};
