function normalizeShop(value: string) {
  return value.trim().toLowerCase();
}

function configuredQuotaOverrideShops() {
  const raw = process.env.AI_SEARCH_QUOTA_OVERRIDE_SHOPS?.trim();
  if (!raw) return new Set<string>();

  return new Set(raw.split(",").map(normalizeShop).filter(Boolean));
}

/**
 * Quota overrides are a support/development capability, not a merchant-facing
 * entitlement control. In production, a global enable flag alone is not
 * sufficient: the current shop must also be explicitly allow-listed.
 */
export function canUseQuotaOverrideUi(shop: string) {
  if (process.env.NODE_ENV !== "production") {
    return true;
  }

  if (process.env.AI_SEARCH_ALLOW_QUOTA_OVERRIDE_UI !== "true") {
    return false;
  }

  return configuredQuotaOverrideShops().has(normalizeShop(shop));
}
