import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { timingSafeEqual } from "node:crypto";

import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { reconcileShopifySubscriptionFromAdmin } from "../services/billing/shopify-app-pricing.server";

const RETRY_DELAYS_MS = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 8 * 60 * 60_000];
const FROZEN_FOLLOWUP_MS = 7 * 24 * 60 * 60_000;
const FROZEN_RETRY_MS = 8 * 60 * 60_000;
const BATCH_SIZE = 50;

function authorized(request: Request) {
  const secret = process.env.BILLING_RECONCILIATION_SECRET;
  const authorization = request.headers.get("authorization") ?? "";
  const supplied = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";

  if (!secret || !supplied) return false;
  const expectedBuffer = Buffer.from(secret);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length &&
    timingSafeEqual(expectedBuffer, suppliedBuffer);
}

async function runDueReconciliation() {
  const now = new Date();
  const due = await db.billingSubscription.findMany({
    where: {
      shopifySubscriptionGid: { not: null },
      status: { in: ["ACTIVE", "FROZEN"] },
      OR: [
        {
          trialEndsAt: { lte: now },
          OR: [
            { currentPeriodEndsAt: null },
            { currentPeriodEndsAt: { lte: now } },
          ],
        },
        { currentPeriodEndsAt: { lte: now } },
        // Frozen subscriptions stay in the follow-up queue even if Shopify's
        // cached period-end field is missing or lies in the future.
        { status: "FROZEN" },
      ],
      AND: [
        {
          OR: [
            { nextReconciliationAt: { lte: now } },
            { nextReconciliationAt: null, reconciliationAttempt: 0 },
          ],
        },
        {
          OR: [
            { status: { not: "FROZEN" } },
            { frozenFollowupUntil: null },
            { frozenFollowupUntil: { gt: now } },
          ],
        },
      ],
    },
    orderBy: [{ nextReconciliationAt: "asc" }, { updatedAt: "asc" }],
    take: BATCH_SIZE,
    select: {
      shop: true,
      shopifySubscriptionGid: true,
      status: true,
      trialEndsAt: true,
      currentPeriodEndsAt: true,
      reconciliationAttempt: true,
      frozenAt: true,
      frozenFollowupUntil: true,
    },
  });

  const results: Array<{ shop: string; subscriptionGid: string; outcome: string }> = [];

  for (const local of due) {
    const gid = local.shopifySubscriptionGid;
    if (!gid) continue;

    try {
      const { admin } = await unauthenticated.admin(local.shop);
      const reconciled = await reconcileShopifySubscriptionFromAdmin({
        shop: local.shop,
        admin,
        expectedSubscriptionGid: gid,
        source: "RECONCILIATION",
      });

      const latest = await db.billingSubscription.findUnique({
        where: { shopifySubscriptionGid: gid },
        select: {
          status: true,
          trialEndsAt: true,
          currentPeriodEndsAt: true,
          frozenAt: true,
          frozenFollowupUntil: true,
          reconciliationAttempt: true,
        },
      });

      if (!latest) {
        results.push({ shop: local.shop, subscriptionGid: gid, outcome: "ROW_REMOVED" });
        continue;
      }

      const checkedAt = new Date();
      const isFrozen = latest.status === "FROZEN";
      const providerWindowStillValid =
        latest.status === "ACTIVE" &&
        latest.currentPeriodEndsAt !== null &&
        latest.currentPeriodEndsAt > checkedAt &&
        (latest.trialEndsAt === null || latest.currentPeriodEndsAt > latest.trialEndsAt);

      if (latest.status !== "ACTIVE" && !isFrozen) {
        await db.billingSubscription.update({
          where: { shopifySubscriptionGid: gid },
          data: {
            nextReconciliationAt: null,
            reconciliationAttempt: 0,
            frozenFollowupUntil: null,
          },
        });
        results.push({ shop: local.shop, subscriptionGid: gid, outcome: "TERMINAL_CONFIRMED" });
        continue;
      }

      if (providerWindowStillValid) {
        await db.billingSubscription.update({
          where: { shopifySubscriptionGid: gid },
          data: {
            nextReconciliationAt: null,
            reconciliationAttempt: 0,
            frozenFollowupUntil: null,
          },
        });
        results.push({ shop: local.shop, subscriptionGid: gid, outcome: "PROVIDER_WINDOW_CONFIRMED" });
        continue;
      }

      if (isFrozen) {
        const followupUntil = latest.frozenFollowupUntil ??
          new Date((latest.frozenAt ?? checkedAt).getTime() + FROZEN_FOLLOWUP_MS);
        if (checkedAt >= followupUntil) {
          await db.billingSubscription.update({
            where: { shopifySubscriptionGid: gid },
            data: { nextReconciliationAt: null, frozenFollowupUntil: followupUntil },
          });
          results.push({ shop: local.shop, subscriptionGid: gid, outcome: "FROZEN_FOLLOWUP_WINDOW_ENDED" });
          continue;
        }

        await db.billingSubscription.update({
          where: { shopifySubscriptionGid: gid },
          data: {
            frozenFollowupUntil: followupUntil,
            nextReconciliationAt: new Date(checkedAt.getTime() + FROZEN_RETRY_MS),
            reconciliationAttempt: { increment: 1 },
          },
        });
        results.push({ shop: local.shop, subscriptionGid: gid, outcome: "FROZEN_RETRY_SCHEDULED" });
        continue;
      }

      const attempt = local.reconciliationAttempt;
      const delay = RETRY_DELAYS_MS[attempt];
      await db.billingSubscription.update({
        where: { shopifySubscriptionGid: gid },
        data: {
          nextReconciliationAt: delay === undefined
            ? null
            : new Date(checkedAt.getTime() + delay),
          reconciliationAttempt: delay === undefined ? attempt : { increment: 1 },
        },
      });
      results.push({
        shop: local.shop,
        subscriptionGid: gid,
        outcome: delay === undefined
          ? "RETRY_SEQUENCE_COMPLETE_NO_PROVIDER_CHANGE"
          : `RETRY_SCHEDULED_${Math.round(delay / 60_000)}_MIN`,
      });

      console.log("[BILLING POLL] due subscription reconciled", {
        shop: local.shop,
        subscriptionGid: gid,
        confirmed: reconciled.confirmed,
        changed: reconciled.changed,
        localStatus: latest.status,
        nextReconciliationAt: delay === undefined
          ? null
          : new Date(checkedAt.getTime() + delay).toISOString(),
      });
    } catch (error) {
      const checkedAt = new Date();
      const delay = RETRY_DELAYS_MS[local.reconciliationAttempt] ?? FROZEN_RETRY_MS;
      await db.billingSubscription.updateMany({
        where: { shopifySubscriptionGid: gid },
        data: {
          nextReconciliationAt: new Date(checkedAt.getTime() + delay),
          reconciliationAttempt: { increment: 1 },
          reconciliationReason: "SCHEDULED_PROVIDER_QUERY_FAILED",
          reconciliationCheckedAt: checkedAt,
        },
      });
      console.error("[BILLING POLL] provider query failed; retry scheduled", {
        shop: local.shop,
        subscriptionGid: gid,
        error: error instanceof Error ? error.message : String(error),
      });
      results.push({ shop: local.shop, subscriptionGid: gid, outcome: "QUERY_FAILED_RETRY_SCHEDULED" });
    }
  }

  return { scanned: due.length, results };
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (!authorized(request)) return new Response("Unauthorized", { status: 401 });
  return Response.json({ ok: true, endpoint: "billing-reconciliation", method: "POST_REQUIRED" }, { status: 405 });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  }
  if (!authorized(request)) return new Response("Unauthorized", { status: 401 });

  try {
    const result = await runDueReconciliation();
    return Response.json({ ok: true, ...result });
  } catch (error) {
    console.error("[BILLING POLL] scheduled reconciliation run failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json({ ok: false, error: "Billing reconciliation failed" }, { status: 500 });
  }
}
