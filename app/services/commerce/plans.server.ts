export const AI_SEARCH_PLAN = {
  none: "NONE",
  basic: "BASIC",
  pro: "PRO",
} as const;

export type AiSearchPlan = (typeof AI_SEARCH_PLAN)[keyof typeof AI_SEARCH_PLAN];

export type PlanLimits = {
  productLimit: number | null;
  searchLimit: number | null;
  vectorUpdateLimit: number | null;
};

export type PlanDefinition = {
  key: AiSearchPlan;
  label: string;
  description: string;
  limits: PlanLimits;
};

export const PLAN_DEFINITIONS: Record<AiSearchPlan, PlanDefinition> = {
  NONE: {
    key: AI_SEARCH_PLAN.none,
    label: "No active plan",
    description:
      "AI Search is disabled until a Shopify App Pricing plan is active.",
    limits: {
      productLimit: 0,
      searchLimit: 0,
      vectorUpdateLimit: 0,
    },
  },
  BASIC: {
    key: AI_SEARCH_PLAN.basic,
    label: "Basic",
    description: "For smaller catalogs with monthly AI usage limits.",
    limits: {
      productLimit: 505,
      searchLimit: 3_000,
      vectorUpdateLimit: 1000,
    },
  },
  PRO: {
    key: AI_SEARCH_PLAN.pro,
    label: "Pro",
    description:
      "Unlimited catalog, AI searches, and vector updates. Usage is still metered for cost and capacity analytics.",
    limits: {
      productLimit: null,
      searchLimit: null,
      vectorUpdateLimit: null,
    },
  },
};

export function normalizePlan(value: string | null | undefined): AiSearchPlan {
  const normalized = value?.trim().toUpperCase();

  if (normalized === AI_SEARCH_PLAN.basic) {
    return AI_SEARCH_PLAN.basic;
  }

  if (normalized === AI_SEARCH_PLAN.pro) {
    return AI_SEARCH_PLAN.pro;
  }

  return AI_SEARCH_PLAN.none;
}

function readHandleList(name: string, fallback: string[]) {
  const raw = process.env[name];

  const handles = (raw ? raw.split(",") : fallback)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  return new Set(handles);
}

export function planFromHandle(
  handle: string | null | undefined,
): AiSearchPlan {
  const clean = handle?.trim().toLowerCase();

  if (!clean) {
    return AI_SEARCH_PLAN.none;
  }

  const basicHandles = readHandleList("AI_SEARCH_BASIC_PLAN_HANDLES", [
    "basic",
    "basic_plan",
    "ai_search_basic",
  ]);

  const proHandles = readHandleList("AI_SEARCH_PRO_PLAN_HANDLES", [
    "pro",
    "pro_plan",
    "ai_search_pro",
  ]);

  if (basicHandles.has(clean)) {
    return AI_SEARCH_PLAN.basic;
  }

  if (proHandles.has(clean)) {
    return AI_SEARCH_PLAN.pro;
  }

  return AI_SEARCH_PLAN.none;
}

export function hasExplicitDevPlanOverride() {
  return Boolean(process.env.AI_SEARCH_DEV_PLAN?.trim());
}

function partnerPricingEnvironmentConfigured() {
  return Boolean(
    process.env.SHOPIFY_PARTNER_ORG_ID?.trim() &&
    process.env.SHOPIFY_PARTNER_API_ACCESS_TOKEN?.trim() &&
    process.env.SHOPIFY_APP_GID?.trim(),
  );
}

export function getDevPlanOverride(): AiSearchPlan | null {
  const value = process.env.AI_SEARCH_DEV_PLAN?.trim();

  if (!value) {
    if (process.env.NODE_ENV === "production") return null;

    // Local development is usable out of the box, but do not silently mask a
    // real Partner API billing configuration. When Partner credentials are
    // present, the canonical Shopify subscription should be exercised.
    return partnerPricingEnvironmentConfigured() ? null : AI_SEARCH_PLAN.basic;
  }

  const plan = normalizePlan(value);
  const allowInProduction =
    process.env.AI_SEARCH_ALLOW_PLAN_OVERRIDE === "true";

  if (process.env.NODE_ENV === "production" && !allowInProduction) {
    return null;
  }

  return plan;
}
