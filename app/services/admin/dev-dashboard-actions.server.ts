import type { ActionFunctionArgs } from "react-router";

import {
  resolveGrantExpiry,
  setCustomPlanTerms,
} from "./dev-dashboard.server";
import {
  requireDevPermission,
  requireDevUser,
  requireRecentDevAuthentication,
} from "../dev-auth.server";
import {
  assertDevCsrf,
  assertDevOrigin,
  readDevSessionToken,
} from "../dev-security.server";
import { writeDevAudit } from "../dev-audit.server";
import {
  createQuotaGrant,
  QUOTA_GRANT_KIND,
  revokeQuotaGrant,
  setAbsoluteQuotaOverridesWithAudit,
  setShopAiEnabledWithAudit,
  type QuotaGrantKind,
} from "../commerce/quota-grants.server";
import {
  createPlanDefinition,
  deletePlanDefinition,
  PLAN_CAPABILITY_DEFINITIONS,
  setPlanActive,
  updatePlanDefinition,
  type SavePlanInput,
} from "../commerce/plan-catalog.server";

function parseNullableNonNegative(form: FormData, name: string) {
  const raw = String(form.get(name) ?? "").trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be blank or >= 0`);
  }
  return Math.trunc(value);
}

function parsePlanInput(form: FormData): SavePlanInput {
  const price = Number(String(form.get("planPrice") ?? "").trim());
  if (!Number.isFinite(price) || price < 0) {
    throw new Error("Plan price must be >= 0.");
  }

  const interval = String(form.get("planInterval") ?? "EVERY_30_DAYS");
  if (!["EVERY_30_DAYS", "ANNUAL"].includes(interval)) {
    throw new Error("Invalid billing interval.");
  }
  const visibility = String(form.get("planVisibility") ?? "PUBLIC");
  if (!["PUBLIC", "PRIVATE", "INTERNAL"].includes(visibility)) {
    throw new Error("Invalid plan visibility.");
  }
  const billingMode = String(form.get("planBillingMode") ?? "MANUAL_BILLING");
  if (!["SHOPIFY_APP_PRICING", "MANUAL_BILLING"].includes(billingMode)) {
    throw new Error("Invalid billing mode.");
  }

  const trialDays = Number(String(form.get("planTrialDays") ?? "0").trim());
  const sortOrder = Number(String(form.get("planSortOrder") ?? "0").trim());
  const capabilities = Object.fromEntries(
    PLAN_CAPABILITY_DEFINITIONS.map(({ key }) => [
      key,
      form.getAll("planCapability").some((value) => String(value) === key),
    ]),
  ) as SavePlanInput["capabilities"];

  const featureKeys = form.getAll("planFeatureKey").map((value) => String(value).trim());
  const featureLabels = form.getAll("planFeatureLabel").map((value) => String(value).trim());
  const enabledFeatureKeys = new Set(
    form.getAll("planFeatureIncluded").map((value) => String(value).trim()),
  );
  const merchantFeatures = featureKeys.map((key, index) => ({
    key,
    label: featureLabels[index] ?? "",
    included: enabledFeatureKeys.has(key),
  }));

  return {
    handle: String(form.get("planHandle") ?? "").trim(),
    name: String(form.get("planName") ?? "").trim(),
    price,
    currencyCode: String(form.get("planCurrency") ?? "USD").trim(),
    interval: interval as SavePlanInput["interval"],
    visibility: visibility as SavePlanInput["visibility"],
    billingMode: billingMode as SavePlanInput["billingMode"],
    trialDays,
    maxIndexedProducts: parseNullableNonNegative(form, "planProductLimit"),
    maxMonthlySearches: parseNullableNonNegative(form, "planSearchLimit"),
    maxMonthlyVectorUpdates: parseNullableNonNegative(form, "planVectorLimit"),
    usageBillingEnabled: form.get("planUsageBillingEnabled") === "on",
    sortOrder,
    isActive: form.get("planIsActive") === "on",
    description: String(form.get("planDescription") ?? "").trim(),
    highlights: String(form.get("planHighlights") ?? "").split(/\r?\n/),
    capabilities,
    merchantFeatures,
  };
}

function optionalPlanNote(form: FormData) {
  return String(form.get("reason") ?? "").trim().slice(0, 1000);
}

function requireReason(form: FormData) {
  const reason = String(form.get("reason") ?? "").trim();
  if (reason.length < 3) throw new Error("Reason is required");
  return reason;
}

export type DevDashboardActionResult = {
  ok: boolean;
  message: string;
};

export async function handleDevDashboardAction({
  request,
}: ActionFunctionArgs): Promise<DevDashboardActionResult> {
  const user = await requireDevUser(request);
  assertDevOrigin(request);

  const sessionToken = readDevSessionToken(request);
  if (!sessionToken) throw new Response("Forbidden", { status: 403 });

  const form = await request.formData();
  assertDevCsrf(sessionToken, form.get("_csrf"));

  const intent = String(form.get("intent") ?? "");
  const targetShop = String(form.get("targetShop") ?? "").trim();
  const actor = `dev:${user.email}`;
  const globalPlanIntent = [
    "create_plan",
    "update_plan",
    "set_plan_active",
    "delete_plan",
  ].includes(intent);

  if (!globalPlanIntent && !targetShop) {
    throw new Response("Target shop is required", { status: 400 });
  }

  if (globalPlanIntent) {
    await requireDevPermission(request, "shop_plan.write");
  } else if (intent === "grant_quota" || intent === "revoke_grant") {
    await requireDevPermission(request, "shop_quota.write");
  } else if (intent === "set_limits") {
    await requireDevPermission(request, "shop_quota.write");
    await requireRecentDevAuthentication(request);
  } else if (intent === "set_custom_plan") {
    await requireDevPermission(request, "shop_plan.write");
  } else if (intent === "toggle_ai") {
    await requireDevPermission(request, "system.write");
    await requireRecentDevAuthentication(request);
  } else {
    throw new Response("Bad Request", { status: 400 });
  }

  try {
    if (intent === "create_plan") {
      const reason = optionalPlanNote(form);
      const plan = await createPlanDefinition(parsePlanInput(form));
      await writeDevAudit({
        request,
        devUserId: user.id,
        action: "PLAN_CREATED",
        resourceType: "plan",
        resourceId: plan.id,
        result: "SUCCESS",
        metadata: { handle: plan.handle, name: plan.name, reason },
      });
      return { ok: true, message: `Plan ${plan.name} created.` };
    }

    if (intent === "update_plan") {
      const planId = String(form.get("planId") ?? "").trim();
      if (!planId) throw new Error("Plan ID is required.");
      const reason = optionalPlanNote(form);
      const plan = await updatePlanDefinition(planId, parsePlanInput(form));
      await writeDevAudit({
        request,
        devUserId: user.id,
        action: "PLAN_UPDATED",
        resourceType: "plan",
        resourceId: plan.id,
        result: "SUCCESS",
        metadata: { handle: plan.handle, name: plan.name, version: plan.version, reason },
      });
      return { ok: true, message: `Plan ${plan.name} updated.` };
    }

    if (intent === "set_plan_active") {
      const planId = String(form.get("planId") ?? "").trim();
      if (!planId) throw new Error("Plan ID is required.");
      const reason = optionalPlanNote(form);
      const enabled = String(form.get("enabled") ?? "") === "true";
      const plan = await setPlanActive(planId, enabled);
      await writeDevAudit({
        request,
        devUserId: user.id,
        action: enabled ? "PLAN_ACTIVATED" : "PLAN_DEACTIVATED",
        resourceType: "plan",
        resourceId: plan.id,
        result: "SUCCESS",
        metadata: { handle: plan.handle, name: plan.name, reason },
      });
      return {
        ok: true,
        message: `Plan ${plan.name} ${enabled ? "activated" : "deactivated"}.`,
      };
    }

    if (intent === "delete_plan") {
      const planId = String(form.get("planId") ?? "").trim();
      if (!planId) throw new Error("Plan ID is required.");
      const reason = optionalPlanNote(form);
      const plan = await deletePlanDefinition(planId);
      await writeDevAudit({
        request,
        devUserId: user.id,
        action: "PLAN_DELETED",
        resourceType: "plan",
        resourceId: plan.id,
        result: "SUCCESS",
        metadata: { handle: plan.handle, name: plan.name, reason: reason || null },
      });
      return { ok: true, message: `Plan ${plan.name} deleted.` };
    }

    if (intent === "grant_quota") {
      const kind = String(form.get("kind") ?? "") as QuotaGrantKind;
      if (!Object.values(QUOTA_GRANT_KIND).includes(kind)) {
        throw new Error("Invalid grant kind");
      }
      const amount = Number(form.get("amount"));
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error("Grant amount must be greater than zero");
      }
      const reason = requireReason(form);
      const expiryMode = String(
        form.get("expiryMode") ?? "BILLING_CYCLE",
      ) as "BILLING_CYCLE" | "30_DAYS" | "NEVER";
      if (!["BILLING_CYCLE", "30_DAYS", "NEVER"].includes(expiryMode)) {
        throw new Error("Invalid grant expiry");
      }
      const expiresAt = await resolveGrantExpiry(targetShop, expiryMode);

      await createQuotaGrant({
        actorShop: actor,
        targetShop,
        kind,
        amount: Math.trunc(amount),
        reason,
        expiresAt,
      });
      await writeDevAudit({
        request,
        devUserId: user.id,
        action: "CHANGE_SHOP_QUOTA",
        resourceType: "shop",
        resourceId: targetShop,
        result: "SUCCESS",
        metadata: { intent, kind, amount: Math.trunc(amount), reason },
      });
      return {
        ok: true,
        message: `Added +${Math.trunc(amount)} ${kind.toLowerCase()} to ${targetShop}.`,
      };
    }

    if (intent === "revoke_grant") {
      const grantId = String(form.get("grantId") ?? "");
      const reason = requireReason(form);
      await revokeQuotaGrant({ actorShop: actor, grantId, reason });
      await writeDevAudit({
        request,
        devUserId: user.id,
        action: "CHANGE_SHOP_QUOTA",
        resourceType: "quota_grant",
        resourceId: grantId,
        result: "SUCCESS",
        metadata: { intent, reason },
      });
      return { ok: true, message: "Stored grant revoked." };
    }

    if (intent === "set_custom_plan") {
      const price = Number(String(form.get("customPrice") ?? "").trim());
      if (!Number.isFinite(price) || price <= 0) {
        throw new Error("Custom price must be greater than 0");
      }

      const interval = String(form.get("customInterval") ?? "EVERY_30_DAYS");
      if (!["EVERY_30_DAYS", "ANNUAL"].includes(interval)) {
        throw new Error("Invalid Custom billing interval.");
      }

      const trialDays = Number(
        String(form.get("customTrialDays") ?? "0").trim(),
      );
      if (
        !Number.isFinite(trialDays) ||
        trialDays < 0 ||
        trialDays > 365
      ) {
        throw new Error("Custom trial days must be between 0 and 365.");
      }

      const capabilities = Object.fromEntries(
        PLAN_CAPABILITY_DEFINITIONS.map(({ key }) => [
          key,
          form
            .getAll("customCapability")
            .some((value) => String(value) === key),
        ]),
      );

      const reason = optionalPlanNote(form);
      const terms = await setCustomPlanTerms({
        actorShop: actor,
        targetShop,
        name: String(form.get("customName") ?? "Custom").trim(),
        price,
        currencyCode: String(
          form.get("customCurrency") ?? "USD",
        ).trim(),
        interval: interval as "EVERY_30_DAYS" | "ANNUAL",
        trialDays: Math.trunc(trialDays),
        productLimit: parseNullableNonNegative(form, "customProductLimit"),
        searchLimit: parseNullableNonNegative(form, "customSearchLimit"),
        vectorUpdateLimit: parseNullableNonNegative(
          form,
          "customVectorUpdateLimit",
        ),
        usageBillingEnabled:
          form.get("customUsageBillingEnabled") === "on",
        description: String(
          form.get("customDescription") ?? "",
        ).trim(),
        highlights: String(
          form.get("customHighlights") ?? "",
        ).split(/\r?\n/),
        capabilities,
        reason,
      });
      await writeDevAudit({
        request,
        devUserId: user.id,
        action: "CHANGE_CUSTOM_PLAN",
        resourceType: "shop",
        resourceId: targetShop,
        result: "SUCCESS",
        metadata: { ...terms, reason },
      });
      return {
        ok: true,
        message: `Custom terms saved for ${targetShop}. Billing and MRR remain unchanged until Shopify activates those terms.`,
      };
    }

    if (intent === "set_limits") {
      const productLimitOverride = parseNullableNonNegative(
        form,
        "productLimitOverride",
      );
      const searchLimitOverride = parseNullableNonNegative(
        form,
        "searchLimitOverride",
      );
      const vectorUpdateLimitOverride = parseNullableNonNegative(
        form,
        "vectorUpdateLimitOverride",
      );
      const reason = requireReason(form);
      await setAbsoluteQuotaOverridesWithAudit({
        actorShop: actor,
        targetShop,
        productLimitOverride,
        searchLimitOverride,
        vectorUpdateLimitOverride,
        reason,
      });
      await writeDevAudit({
        request,
        devUserId: user.id,
        action: "CHANGE_SHOP_LIMITS",
        resourceType: "shop",
        resourceId: targetShop,
        result: "SUCCESS",
        metadata: {
          productLimitOverride,
          searchLimitOverride,
          vectorUpdateLimitOverride,
          reason,
        },
      });
      return { ok: true, message: `Absolute limits updated for ${targetShop}.` };
    }

    const enabled = String(form.get("enabled")) === "true";
    const reason = requireReason(form);
    await setShopAiEnabledWithAudit({
      actorShop: actor,
      targetShop,
      enabled,
      reason,
    });
    await writeDevAudit({
      request,
      devUserId: user.id,
      action: "CHANGE_SHOP_AI_STATE",
      resourceType: "shop",
      resourceId: targetShop,
      result: "SUCCESS",
      metadata: { enabled, reason },
    });
    return {
      ok: true,
      message: `AI Search ${enabled ? "enabled" : "disabled"} for ${targetShop}.`,
    };
  } catch (error) {
    await writeDevAudit({
      request,
      devUserId: user.id,
      action: "DEV_DASHBOARD_MUTATION",
      resourceType: targetShop ? "shop" : null,
      resourceId: targetShop || null,
      result: "FAILED",
      metadata: {
        intent,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Operation failed. Check audit history for details.",
    };
  }
}
