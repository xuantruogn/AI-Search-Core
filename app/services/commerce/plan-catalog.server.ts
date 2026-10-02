import type { BillingInterval, BillingMode, PlanVisibility, Prisma } from "@prisma/client";

import db from "../../db.server";

export const PLAN_CAPABILITY_DEFINITIONS = [
  { key: "semanticSearch", label: "Semantic search" },
  { key: "multilingualSearch", label: "Multilingual query translation" },
  { key: "searchAnalytics", label: "Search analytics" },
  { key: "themeIntegration", label: "Theme Map integration" },
  { key: "selfRendering", label: "Self-rendering storefront mode" },
  { key: "customDataMode", label: "Custom data mode" },
] as const;

export type PlanCapabilityKey =
  (typeof PLAN_CAPABILITY_DEFINITIONS)[number]["key"];

export type PlanFeatureConfig = {
  description: string;
  highlights: string[];
  capabilities: Record<PlanCapabilityKey, boolean>;
};

const DEFAULT_CAPABILITIES: Record<PlanCapabilityKey, boolean> = {
  semanticSearch: true,
  multilingualSearch: true,
  searchAnalytics: true,
  themeIntegration: true,
  selfRendering: true,
  customDataMode: false,
};

export function disabledPlanFeatureConfig(): PlanFeatureConfig {
  return {
    description: "",
    highlights: [],
    capabilities: Object.fromEntries(
      PLAN_CAPABILITY_DEFINITIONS.map(({ key }) => [key, false]),
    ) as Record<PlanCapabilityKey, boolean>,
  };
}

function cleanText(value: unknown, max: number) {
  return String(value ?? "").trim().slice(0, max);
}

function cleanHighlights(values: unknown) {
  const rows = Array.isArray(values)
    ? values
    : String(values ?? "").split(/\r?\n/);
  return [...new Set(
    rows
      .map((value) => cleanText(value, 180))
      .filter(Boolean),
  )].slice(0, 12);
}
export function parsePlanFeatureFlags(value: unknown): PlanFeatureConfig {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const storedCapabilities =
    record.capabilities &&
    typeof record.capabilities === "object" &&
    !Array.isArray(record.capabilities)
      ? (record.capabilities as Record<string, unknown>)
      : {};

  const capabilities = { ...DEFAULT_CAPABILITIES };
  for (const definition of PLAN_CAPABILITY_DEFINITIONS) {
    if (typeof storedCapabilities[definition.key] === "boolean") {
      capabilities[definition.key] = storedCapabilities[definition.key] as boolean;
    }
  }

  return {
    description: cleanText(record.description, 500),
    highlights: cleanHighlights(record.highlights),
    capabilities,
  };
}

export type SavePlanInput = {
  handle?: string;
  name: string;
  price: number;
  currencyCode: string;
  interval: BillingInterval;
  visibility: PlanVisibility;
  billingMode: BillingMode;
  trialDays: number;
  maxIndexedProducts: number | null;
  maxMonthlySearches: number | null;
  maxMonthlyVectorUpdates: number | null;
  usageBillingEnabled: boolean;
  sortOrder: number;
  isActive: boolean;
  description: string;
  highlights: string[];
  capabilities: Partial<Record<PlanCapabilityKey, boolean>>;
};

function normalizeHandle(value: string) {
  const handle = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(handle)) {
    throw new Error(
      "Plan handle must be 2-64 lowercase letters, numbers, hyphens or underscores.",
    );
  }
  return handle;
}
function validateInput(input: SavePlanInput) {
  const name = cleanText(input.name, 120);
  if (!name) throw new Error("Plan name is required.");

  if (!Number.isFinite(input.price) || input.price < 0 || input.price > 99_999_999) {
    throw new Error("Plan price must be between 0 and 99,999,999.");
  }

  const currencyCode = input.currencyCode.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currencyCode)) {
    throw new Error("Currency must be a 3-letter ISO currency code.");
  }

  const trialDays = Math.trunc(input.trialDays);
  if (!Number.isFinite(trialDays) || trialDays < 0 || trialDays > 365) {
    throw new Error("Trial days must be between 0 and 365.");
  }

  const normalizeLimit = (value: number | null, label: string) => {
    if (value === null) return null;
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${label} must be blank for unlimited or >= 0.`);
    }
    return Math.trunc(value);
  };

  const capabilities = { ...DEFAULT_CAPABILITIES };
  for (const definition of PLAN_CAPABILITY_DEFINITIONS) {
    if (typeof input.capabilities[definition.key] === "boolean") {
      capabilities[definition.key] = input.capabilities[definition.key] as boolean;
    }
  }

  return {
    name,
    price: input.price,
    currencyCode,
    interval: input.interval,
    visibility: input.visibility,
    billingMode: input.billingMode,
    trialDays,
    maxIndexedProducts: normalizeLimit(input.maxIndexedProducts, "Product limit"),
    maxMonthlySearches: normalizeLimit(input.maxMonthlySearches, "Search limit"),
    maxMonthlyVectorUpdates: normalizeLimit(
      input.maxMonthlyVectorUpdates,
      "Vector update limit",
    ),
    usageBillingEnabled: Boolean(input.usageBillingEnabled),
    sortOrder: Number.isFinite(input.sortOrder) ? Math.trunc(input.sortOrder) : 0,
    isActive: Boolean(input.isActive),
    featureFlags: {
      description: cleanText(input.description, 500),
      highlights: cleanHighlights(input.highlights),
      capabilities,
    } satisfies Prisma.InputJsonValue,
  };
}
export async function createPlanDefinition(input: SavePlanInput) {
  const handle = normalizeHandle(input.handle ?? "");
  if (handle === "custom" || handle === "none") {
    throw new Error(`Plan handle "${handle}" is reserved by the billing system.`);
  }
  const data = validateInput(input);

  const existing = await db.plan.findUnique({
    where: { handle },
    select: { id: true },
  });
  if (existing) throw new Error(`Plan handle "${handle}" already exists.`);

  return db.plan.create({
    data: {
      handle,
      ...data,
    },
  });
}

export async function updatePlanDefinition(
  planId: string,
  input: SavePlanInput,
) {
  const existing = await db.plan.findUnique({
    where: { id: planId },
    select: { id: true, handle: true, version: true },
  });
  if (!existing) throw new Error("Plan not found.");

  const data = validateInput(input);
  return db.plan.update({
    where: { id: planId },
    data: {
      ...data,
      version: existing.version + 1,
    },
  });
}

export async function setPlanActive(planId: string, isActive: boolean) {
  const existing = await db.plan.findUnique({
    where: { id: planId },
    select: { id: true, version: true },
  });
  if (!existing) throw new Error("Plan not found.");

  return db.plan.update({
    where: { id: planId },
    data: {
      isActive,
      version: existing.version + 1,
    },
  });
}


export async function getShopCustomPlanAssignment(
  shop: string,
  options: { activeOnly?: boolean } = {},
) {
  const now = new Date();
  const activeOnly = options.activeOnly ?? true;

  return db.planAssignment.findFirst({
    where: {
      shop,
      plan: { handle: "custom" },
      ...(activeOnly
        ? {
            isActive: true,
            AND: [
              { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
              { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
            ],
          }
        : {}),
    },
    include: { plan: true },
    orderBy: { updatedAt: "desc" },
  });
}

export function resolveShopCustomPlanTerms(
  assignment: Awaited<ReturnType<typeof getShopCustomPlanAssignment>>,
) {
  if (!assignment) return null;

  const features = parsePlanFeatureFlags(
    assignment.customFeatureFlags ?? assignment.plan.featureFlags,
  );

  return {
    assignmentId: assignment.id,
    planId: assignment.planId,
    handle: "custom",
    name: cleanText(assignment.customName ?? assignment.plan.name ?? "Custom", 120) || "Custom",
    price:
      assignment.customPriceOverride === null
        ? null
        : Number(assignment.customPriceOverride),
    currencyCode: (
      assignment.customCurrencyCode ??
      assignment.plan.currencyCode ??
      "USD"
    ).toUpperCase(),
    interval: assignment.customInterval ?? assignment.plan.interval,
    trialDays: Math.max(
      0,
      Math.min(
        365,
        assignment.customTrialDays ?? assignment.plan.trialDays ?? 0,
      ),
    ),
    limits: {
      productLimit: assignment.customMaxIndexedProducts,
      searchLimit: assignment.customMaxMonthlySearches,
      vectorUpdateLimit: assignment.customMaxMonthlyVectorUpdates,
    },
    usageBillingEnabled:
      assignment.customUsageBillingEnabled ??
      assignment.plan.usageBillingEnabled,
    features,
    notes: assignment.notes,
    isActive: assignment.isActive === true,
    startsAt: assignment.startsAt,
    endsAt: assignment.endsAt,
    updatedAt: assignment.updatedAt,
  };
}
