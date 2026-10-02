import type { AiSearchPlan, PlanLimits } from "./plans.server";
import type {
  BillingAccessStatus,
  BillingCancellationStatus,
  BillingChargeStatus,
  BillingCommercialStatus,
  BillingPaymentStatus,
  BillingPlanChangeStatus,
  BillingReconciliationStatus,
  BillingRefundStatus,
  BillingTrialStatus,
} from "./billing-state.server";
import type { PlanFeatureConfig } from "./plan-catalog.server";

export type SubscriptionSnapshot = {
  shop: string;
  plan: AiSearchPlan;
  planId: string | null;
  planLabel: string;
  features: PlanFeatureConfig;
  limits: PlanLimits;
  status: string;
  planHandle: string | null;
  shopifySubscriptionId: string | null;
  billingPeriodStart: Date | null;
  billingPeriodEnd: Date | null;
  billingInterval: "EVERY_30_DAYS" | "ANNUAL" | null;
  commercialStatus: BillingCommercialStatus;
  trialStatus: BillingTrialStatus;
  trialStartsAt: Date | null;
  trialEndsAt: Date | null;
  cancellationStatus: BillingCancellationStatus;
  planChangeStatus: BillingPlanChangeStatus;
  chargeStatus: BillingChargeStatus;
  paymentStatus: BillingPaymentStatus;
  refundStatus: BillingRefundStatus;
  accessStatus: BillingAccessStatus;
  reconciliationStatus: BillingReconciliationStatus;
  reconciliationReason: string | null;
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
  cancellationStatus: BillingCancellationStatus;
  active: boolean;
  aiSearchEnabled: boolean;
  fallbackEnabled: boolean;
  features: PlanFeatureConfig;
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
