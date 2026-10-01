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

function parseNullableNonNegative(form: FormData, name: string) {
  const raw = String(form.get(name) ?? "").trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be blank or >= 0`);
  }
  return Math.trunc(value);
}

function parseRequiredNonNegative(form: FormData, name: string) {
  const raw = String(form.get(name) ?? "").trim();
  if (!raw) throw new Error(`${name} is required`);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be >= 0`);
  }
  return Math.trunc(value);
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

  if (!targetShop) throw new Response("Target shop is required", { status: 400 });

  if (intent === "grant_quota" || intent === "revoke_grant") {
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
      const productLimit = parseRequiredNonNegative(form, "customProductLimit");
      const searchLimit = parseRequiredNonNegative(form, "customSearchLimit");
      const vectorUpdateLimit = parseRequiredNonNegative(
        form,
        "customVectorUpdateLimit",
      );
      const reason = requireReason(form);
      const terms = await setCustomPlanTerms({
        actorShop: actor,
        targetShop,
        price,
        productLimit,
        searchLimit,
        vectorUpdateLimit,
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
