import db from "../../db.server";
import {
  AI_SEARCH_PLAN,
  hasExplicitDevPlanOverride,
  planFromHandle,
} from "../commerce/plans.server";
import {
  ensureShopRecord,
  fetchShopIdentity,
  getSubscriptionSnapshot,
} from "../commerce/shop-registry.server";
import {
  ensureBillingV2State,
  mirrorBillingStateToLegacy,
  recordBillingEvent,
} from "../commerce/billing-state.server";
import { withDistributedLease } from "../commerce/lease-lock.server";

type AdminGraphqlClient = {
  graphql: (
    query: string,
    options?: {
      variables?: Record<string, unknown>;
    },
  ) => Promise<Response>;
};

type ShopifySubscriptionStatus =
  | "PENDING"
  | "ACTIVE"
  | "FROZEN"
  | "CANCELLED"
  | "DECLINED"
  | "EXPIRED";

type AdminSubscription = {
  id: string;
  name: string;
  status: ShopifySubscriptionStatus;
  createdAt: string;
  updatedAt?: string;
  currentPeriodEnd?: string | null;
  trialDays?: number;
  test?: boolean;
  lineItems?: Array<{
    id: string;
    plan?: {
      pricingDetails?: {
        __typename?: string;
        planHandle?: string | null;
        interval?: string | null;
        price?: {
          amount?: string | null;
          currencyCode?: string | null;
        } | null;
      } | null;
    } | null;
  }>;
};

type AdminSubscriptionsResponse = {
  data?: {
    currentAppInstallation?: {
      activeSubscriptions?: AdminSubscription[];
      allSubscriptions?: {
        nodes?: AdminSubscription[];
        pageInfo?: {
          hasNextPage?: boolean;
          endCursor?: string | null;
        };
      };
    } | null;
  };
  errors?: Array<{
    message?: string;
  }>;
};

function isShopifySubscriptionStatus(
  value: string,
): value is ShopifySubscriptionStatus {
  return (
    value === "PENDING" ||
    value === "ACTIVE" ||
    value === "FROZEN" ||
    value === "CANCELLED" ||
    value === "DECLINED" ||
    value === "EXPIRED"
  );
}

/**
 * Compatibility export retained because existing routes still import this
 * helper under the historical App Pricing name.
 *
 * The implementation is now Manual Billing / Admin GraphQL. There is no
 * Shopify Partner API dependency here.
 */
export function isShopifyAppPricingConfigured() {
  return true;
}

/**
 * Compatibility export retained for the existing Billing UI.
 * Manual Billing uses appSubscriptionCreate().confirmationUrl instead of a
 * Partner App Pricing URL.
 */
export function getShopifyPricingPlansUrl(_shop: string) {
  return null;
}

function parseShopifyDate(value: string | null | undefined) {
  if (!value) return null;

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function inferPlan({
  preferredPlanHandle,
  itemHandles,
}: {
  preferredPlanHandle?: string | null;
  itemHandles: string[];
}) {
  /**
   * The Shopify line-item plan handle is authoritative.
   * preferredPlanHandle is only a local hint used when Shopify's response
   * does not expose a recognized handle.
   */
  const recognized = itemHandles
    .map((handle) => ({ handle, plan: planFromHandle(handle) }))
    .filter((item) => item.plan !== AI_SEARCH_PLAN.none);

  const pro = recognized.find(
    (item) => item.plan === AI_SEARCH_PLAN.pro,
  );
  if (pro) return { plan: pro.plan, planHandle: pro.handle };

  const basic = recognized.find(
    (item) => item.plan === AI_SEARCH_PLAN.basic,
  );
  if (basic) return { plan: basic.plan, planHandle: basic.handle };

  const preferred = preferredPlanHandle?.trim();
  if (preferred) {
    const preferredPlan = planFromHandle(preferred);
    if (preferredPlan !== AI_SEARCH_PLAN.none) {
      return {
        plan: preferredPlan,
        planHandle: preferred,
      };
    }
  }

  return {
    plan:
      itemHandles.length > 0
        ? AI_SEARCH_PLAN.custom
        : AI_SEARCH_PLAN.none,
    planHandle: itemHandles[0] ?? preferred ?? null,
  };
}

async function queryAdminSubscription(
  admin: AdminGraphqlClient,
  expectedSubscriptionGid?: string | null,
) {
  const response = await admin.graphql(
    `#graphql
      query GetCurrentAppSubscriptions {
        currentAppInstallation {
          activeSubscriptions {
            id
            name
            status
            createdAt
            updatedAt
            currentPeriodEnd
            trialDays
            test
            lineItems {
              id
              plan {
                pricingDetails {
                  __typename
                  ... on AppRecurringPricing {
                    planHandle
                    interval
                    price {
                      amount
                      currencyCode
                    }
                  }
                }
              }
            }
          }
          allSubscriptions(first: 100) {
            nodes {
              id
              name
              status
              createdAt
              updatedAt
              currentPeriodEnd
              trialDays
              test
              lineItems {
                id
                plan {
                  pricingDetails {
                    __typename
                    ... on AppRecurringPricing {
                      planHandle
                      interval
                      price {
                        amount
                        currencyCode
                      }
                    }
                  }
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    `,
  );

  const body = (await response.json()) as AdminSubscriptionsResponse;

  if (!response.ok || body.errors?.length) {
    const message =
      body.errors
        ?.map((error) => error.message)
        .filter(Boolean)
        .join("; ") || "Shopify Admin API request failed.";

    throw new Error(message);
  }

  const installation = body.data?.currentAppInstallation;
  const activeSubscriptions = installation?.activeSubscriptions ?? [];
  const allSubscriptions = installation?.allSubscriptions?.nodes ?? [];

  const byId = new Map<string, AdminSubscription>();

  for (const subscription of allSubscriptions) {
    if (isShopifySubscriptionStatus(subscription.status)) {
      byId.set(subscription.id, subscription);
    }
  }

  // activeSubscriptions is kept as a second source for the current ACTIVE
  // view. allSubscriptions remains the lifecycle source of truth.
  for (const subscription of activeSubscriptions) {
    if (isShopifySubscriptionStatus(subscription.status)) {
      byId.set(subscription.id, subscription);
    }
  }

  const subscriptions = [...byId.values()];

  if (expectedSubscriptionGid) {
    return (
      subscriptions.find(
        (subscription) => subscription.id === expectedSubscriptionGid,
      ) ?? null
    );
  }

  /**
   * A reconciliation without an expected GID is a current-state sync.
   * Only an actual ACTIVE subscription may become the current entitlement.
   * If Shopify has no ACTIVE subscription, return null and DO NOT infer
   * CANCELLED from absence.
   */
  return (
    subscriptions
      .filter((subscription) => subscription.status === "ACTIVE")
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() -
          new Date(a.createdAt).getTime(),
      )[0] ?? null
  );
}

async function resolvePlan({
  shop,
  planHandle,
  plan,
}: {
  shop: string;
  planHandle: string;
  plan: string;
}) {
  if (
    plan === AI_SEARCH_PLAN.basic ||
    plan === AI_SEARCH_PLAN.pro
  ) {
    return db.plan.findUnique({
      where: { handle: plan.toLowerCase() },
    });
  }

  const direct = await db.plan.findFirst({
    where: {
      OR: [
        { handle: planHandle },
        { shopifyPlanHandle: planHandle },
      ],
    },
  });

  if (direct) return direct;

  const assignment = await db.planAssignment.findFirst({
    where: {
      shop,
      isActive: true,
      plan: {
        OR: [
          { handle: planHandle },
          { shopifyPlanHandle: planHandle },
        ],
      },
    },
    include: { plan: true },
    orderBy: { createdAt: "desc" },
  });

  return assignment?.plan ?? null;
}

async function reconcileManualShopifySubscription({
  shop,
  admin,
  preferredPlanHandle,
  authoritativePlanHandle,
  adminSubscription,
  source = "API",
}: {
  shop: string;
  admin: AdminGraphqlClient;
  preferredPlanHandle?: string | null;
  authoritativePlanHandle?: string | null;
  adminSubscription: AdminSubscription;
  source?: "CALLBACK" | "WEBHOOK" | "API" | "RECONCILIATION";
}) {
  const identity = await fetchShopIdentity(admin);

  await ensureShopRecord({
    shop,
    shopifyShopId: identity.id,
    reactivate: true,
  });

  const before = await getSubscriptionSnapshot(shop);

  const billingState = await ensureBillingV2State(shop);

  const gid = adminSubscription.id;
  const status = adminSubscription.status;

  // A subscription GID is immutable. Once CREATE/callback has mapped that
  // exact GID to a plan, lifecycle webhooks must preserve that mapping even
  // when Shopify's pricing item does not expose a plan handle.
  const current = await db.billingSubscription.findUnique({
    where: { shopifySubscriptionGid: gid },
  });

  const persistedPlanHandle = current?.shopifyPlanHandle?.trim() || null;
  const persistedPlan = persistedPlanHandle
    ? planFromHandle(persistedPlanHandle)
    : AI_SEARCH_PLAN.none;

  // Manual Billing can briefly return no exact subscription from the Admin
  // API immediately after approval. If the webhook arrives in that window,
  // plan_handle may also be null. Resolve the plan by the exact subscription
  // GID pointer before falling back to legacy/current state.
  const shopPointer = await db.aiSearchShop.findUnique({
    where: { shop },
    select: {
      currentPlanHandle: true,
      currentSubscriptionGid: true,
      pendingPlanHandle: true,
      pendingSubscriptionGid: true,
    },
  });

  const exactPointerPlanHandle =
    shopPointer?.pendingSubscriptionGid === gid
      ? shopPointer.pendingPlanHandle?.trim().toLowerCase() || null
      : shopPointer?.currentSubscriptionGid === gid
        ? shopPointer.currentPlanHandle?.trim().toLowerCase() || null
        : null;

  const itemHandles = (adminSubscription.lineItems ?? [])
    .map(
      (item) =>
        item.plan?.pricingDetails?.planHandle?.trim() ?? null,
    )
    .filter((value): value is string => Boolean(value));

     console.log("[BILLING DEBUG] Plan mapping inputs:", {
      gid,
      status,
      authoritativePlanHandle,
      preferredPlanHandle,
      persistedPlanHandle,
      persistedPlan,
      exactPointerPlanHandle,
      currentSubscriptionGid: shopPointer?.currentSubscriptionGid ?? null,
      pendingSubscriptionGid: shopPointer?.pendingSubscriptionGid ?? null,
      itemHandles,
    }); 

  // Manual Billing subscriptions created with appSubscriptionCreate may not
  // expose a planHandle on AppRecurringPricing. In that case, keep Shopify
  // as the source of truth for the subscription/GID/status and use the
  // already-persisted plan handle only as the local plan mapping hint.
        const authoritativeHandle =
          authoritativePlanHandle?.trim().toLowerCase() || null;

        const planMappingHint =
          preferredPlanHandle?.trim().toLowerCase() ||
          billingState.legacy?.planHandle?.trim().toLowerCase() ||
          null;

        let inferred: ReturnType<typeof inferPlan>;

        const authoritativePlan = authoritativeHandle
          ? planFromHandle(authoritativeHandle)
          : AI_SEARCH_PLAN.none;

        if (
          authoritativeHandle &&
          authoritativePlan !== AI_SEARCH_PLAN.none
        ) {
          inferred = {
            plan: authoritativePlan,
            planHandle: authoritativeHandle,
          };
        } else if (exactPointerPlanHandle) {
          // For a transition, the exact GID's pending/current pointer is more
          // authoritative than a previously persisted row for that GID.
          // This prevents a stale/wrong row from locking a new BASIC GID to
          // the previous PRO plan (or vice versa).
          const pointerPlan = planFromHandle(exactPointerPlanHandle);
          if (pointerPlan !== AI_SEARCH_PLAN.none) {
            inferred = {
              plan: pointerPlan,
              planHandle: exactPointerPlanHandle,
            };
          } else {
            inferred = inferPlan({
              preferredPlanHandle: planMappingHint,
              itemHandles,
            });
          }
        } else if (
          persistedPlanHandle &&
          persistedPlan !== AI_SEARCH_PLAN.none
        ) {
          inferred = {
            plan: persistedPlan,
            planHandle: persistedPlanHandle.toLowerCase(),
          };
        } else {
          inferred = inferPlan({
            preferredPlanHandle: planMappingHint,
            itemHandles,
          });
        }

  if (!inferred.planHandle) {
    throw new Error(
      `Shopify subscription ${adminSubscription.id} has no plan handle.`,
    );
  }

  console.log("[BILLING DEBUG] Plan mapping result:", {
    gid,
    inferredPlan: inferred.plan,
    inferredPlanHandle: inferred.planHandle,
  });

  const plan = await resolvePlan({
    shop,
    planHandle: inferred.planHandle,
    plan: inferred.plan,
  });

  if (!plan) {
    throw new Error(
      `Shopify Billing plan "${inferred.planHandle}" is not configured in Billing V2.`,
    );
  }

  const start = parseShopifyDate(adminSubscription.createdAt);
  const end = parseShopifyDate(adminSubscription.currentPeriodEnd);

  // Shopify's exact recurring pricing details are authoritative for the
  // purchased cycle and charge amount. The local Plan row remains the
  // entitlement/limits definition and must not overwrite the actual
  // Shopify charge with its default monthly values.
  const recurringPricing = (adminSubscription.lineItems ?? [])
    .map((item) => item.plan?.pricingDetails)
    .find(
      (details) =>
        details?.interval === "EVERY_30_DAYS" ||
        details?.interval === "ANNUAL",
    );

  const shopifyInterval =
    recurringPricing?.interval === "ANNUAL"
      ? "ANNUAL"
      : recurringPricing?.interval === "EVERY_30_DAYS"
        ? "EVERY_30_DAYS"
        : null;

  const shopifyPrice = recurringPricing?.price?.amount ?? null;
  const shopifyCurrency = recurringPricing?.price?.currencyCode ?? null;

  /**
   * Replacement handling is anchored to AiSearchShop.currentSubscriptionGid.
   * Never pick the "latest updated" PENDING subscription as the old/current
   * subscription: multiple pending replacement flows can legitimately exist
   * in Billing V2. Only the subscription that was actually the current
   * entitlement may be closed when Shopify makes the new subscription ACTIVE.
   */
  if (!current && status === "ACTIVE") {
    const shopPointer = await db.aiSearchShop.findUnique({
      where: { shop },
      select: { currentSubscriptionGid: true },
    });

    const previous = shopPointer?.currentSubscriptionGid
      ? await db.billingSubscription.findUnique({
          where: {
            shopifySubscriptionGid: shopPointer.currentSubscriptionGid,
          },
        })
      : await db.billingSubscription.findFirst({
          where: {
            shop,
            status: { in: ["ACTIVE", "FROZEN"] },
          },
          orderBy: { updatedAt: "desc" },
        });

    if (
      previous &&
      previous.shopifySubscriptionGid &&
      previous.shopifySubscriptionGid !== gid &&
      (previous.status === "ACTIVE" || previous.status === "FROZEN")
    ) {
      await db.billingSubscription.update({
        where: { id: previous.id },
        data: {
          status: "CANCELLED",
          cancelledAt: new Date(),
        },
      });

      await recordBillingEvent({
        shop,
        subscriptionGid: previous.shopifySubscriptionGid,
        type: "SUBSCRIPTION_CANCELLED",
        source: "API",
        idempotencyKey:
          `subscription-replaced:${previous.shopifySubscriptionGid}:${gid}`,
        payload: {
          reason: "SHOPIFY_SUBSCRIPTION_REPLACED",
          replacementSubscriptionGid: gid,
        },
      });
    }
  }

  const previousStatus = current?.status ?? null;
  const shopifyCreatedAt = parseShopifyDate(adminSubscription.createdAt);
  const shopifyUpdatedAt = parseShopifyDate(adminSubscription.updatedAt);
  const now = new Date();

  const trialDays = Math.max(0, adminSubscription.trialDays ?? 0);
  const trialStartsAt =
    current?.trialStartsAt ??
    (trialDays > 0 ? shopifyCreatedAt : null);
  const trialEndsAt =
    current?.trialEndsAt ??
    (trialDays > 0 && shopifyCreatedAt
      ? new Date(
          shopifyCreatedAt.getTime() +
            trialDays * 24 * 60 * 60 * 1000,
        )
      : null);

  const previousTrialStatus = current?.trialStatus ?? "NONE";

  const trialStatus =
    status !== "ACTIVE"
      ? status === "CANCELLED" || status === "DECLINED" || status === "EXPIRED"
        ? trialEndsAt && now < trialEndsAt
          ? "CANCELLED"
          : "ENDED"
        : "NONE"
      : !trialStartsAt || !trialEndsAt
        ? "NONE"
        : now < trialEndsAt
          ? "ACTIVE"
          : "ENDED";

  const previousPlanKey = before.plan;

  const isReplacementActivation =
    status === "ACTIVE" &&
    previousStatus !== "ACTIVE" &&
    Boolean(before.shopifySubscriptionId) &&
    before.shopifySubscriptionId !== gid &&
    Boolean(before.planHandle) &&
    before.planHandle !== inferred.planHandle;

  const replacementStatus =
    status === "PENDING"
      ? "PENDING"
      : status === "DECLINED"
        ? "DECLINED"
        : status === "EXPIRED"
          ? "EXPIRED"
          : isReplacementActivation
            ? "APPLIED"
            : (current?.planChangeStatus ?? "NONE");

  const cancellationStatus =
    status === "CANCELLED"
      ? "EFFECTIVE"
      : (current?.cancellationStatus ?? "NONE");

  const chargeStatus =
    status === "FROZEN"
      ? "FAILED"
      : status === "PENDING"
        ? "PENDING"
        : status === "ACTIVE" && trialStatus === "ACTIVE"
          ? "NONE"
          : status === "ACTIVE"
            ? "PAID"
            : "NONE";

  const paymentStatus =
    status === "FROZEN"
      ? "FAILED"
      : status === "PENDING"
        ? "PENDING"
        : status === "ACTIVE" && previousStatus === "FROZEN"
          ? "RECOVERED"
          : status === "ACTIVE" && trialStatus === "ACTIVE"
            ? "NONE"
            : status === "ACTIVE"
              ? "PAID"
              : "NONE";

  const accessStatus =
    status === "FROZEN"
      ? "SUSPENDED"
      : status === "ACTIVE"
        ? inferred.plan === AI_SEARCH_PLAN.basic
          ? "BASIC"
          : inferred.plan === AI_SEARCH_PLAN.pro
            ? "PRO"
            : "CUSTOM"
        : "NONE";

  const reconciliationReason = null;

  console.log("[BILLING MATRIX] reconcile transition:", {
    shop,
    source,
    gid,
    previousStatus,
    status,
    previousPlan: previousPlanKey,
    nextPlan: inferred.plan,
    previousPlanHandle: before.planHandle,
    nextPlanHandle: inferred.planHandle,
    trialStatus,
    cancellationStatus,
    planChangeStatus: replacementStatus,
    chargeStatus,
    paymentStatus,
    accessStatus,
    currentSubscriptionGid: shopPointer?.currentSubscriptionGid ?? null,
    pendingSubscriptionGid: shopPointer?.pendingSubscriptionGid ?? null,
    pendingPlanHandle: shopPointer?.pendingPlanHandle ?? null,
    shopifyCreatedAt: shopifyCreatedAt?.toISOString() ?? null,
    shopifyUpdatedAt: shopifyUpdatedAt?.toISOString() ?? null,
  });

  const data = {
    shop,
    planId: plan.id,
    shopifySubscriptionGid: gid,
    shopifyPlanHandle: inferred.planHandle,
    status,
    planNameSnapshot: plan.name,
    priceSnapshot: shopifyPrice ?? plan.price,
    currencySnapshot: shopifyCurrency ?? plan.currencyCode,
    intervalSnapshot: shopifyInterval ?? plan.interval,
    shopifyCreatedAt,
    shopifyUpdatedAt,
    trialStatus,
    cancellationStatus,
    planChangeStatus: replacementStatus,
    chargeStatus,
    paymentStatus,
    refundStatus: current?.refundStatus ?? "NONE",
    accessStatus,
    reconciliationStatus: "SYNCED",
    reconciliationCheckedAt: now,
    reconciliationReason,
    repairRequiredAt: null,
    trialStartsAt,
    trialEndsAt,
    currentPeriodStartsAt: start,
    currentPeriodEndsAt: end,
    activatedAt:
      status === "ACTIVE"
        ? current?.activatedAt ?? new Date()
        : current?.activatedAt ?? null,
    frozenAt:
      status === "FROZEN"
        ? current?.frozenAt ?? new Date()
        : current?.frozenAt ?? null,
    cancelledAt:
      status === "CANCELLED"
        ? current?.cancelledAt ?? new Date()
        : current?.cancelledAt ?? null,
    testMode:
      adminSubscription.test ?? process.env.NODE_ENV !== "production",
    rawResponse: {
      ...(adminSubscription as unknown as Record<string, unknown>),
      reconciliationSource: source,
      reconciledAt: now.toISOString(),
    },
  };

  // Callback and APP_SUBSCRIPTIONS_UPDATE can reconcile the same exact GID
  // concurrently. Use the unique Shopify GID as the database identity so the
  // second reconciler updates the row instead of throwing a unique-constraint
  // error and turning the billing callback into a white screen.
  const subscription = await db.billingSubscription.upsert({
    where: { shopifySubscriptionGid: gid },
    create: data,
    update: data,
  });

  // One local charge record represents one Shopify billing period. The real
  // Shopify charge ID can be attached later when/if that provider record is
  // available; lifecycle state is still derived from the subscription state.
  if (start) {
    await db.billingCharge.upsert({
      where: {
        subscriptionGid_billingPeriodStart: {
          subscriptionGid: gid,
          billingPeriodStart: start,
        },
      },
      create: {
        shop,
        subscriptionGid: gid,
        status: chargeStatus,
        amount: shopifyPrice ?? plan.price,
        currency: shopifyCurrency ?? plan.currencyCode,
        billingPeriodStart: start,
        billingPeriodEnd: end,
        acceptedAt:
          previousStatus === "PENDING" && status === "ACTIVE"
            ? now
            : null,
        activatedAt: status === "ACTIVE" ? now : null,
        paidAt:
          status === "ACTIVE" && trialStatus !== "ACTIVE"
            ? now
            : null,
        failedAt: status === "FROZEN" ? now : null,
        frozenAt: status === "FROZEN" ? now : null,
        testMode:
          adminSubscription.test ?? process.env.NODE_ENV !== "production",
        rawResponse: {
          subscriptionGid: gid,
          shopifyUpdatedAt: shopifyUpdatedAt?.toISOString() ?? null,
          status,
        },
      },
      update: {
        status: chargeStatus,
        amount: shopifyPrice ?? plan.price,
        currency: shopifyCurrency ?? plan.currencyCode,
        billingPeriodEnd: end,
        acceptedAt:
          previousStatus === "PENDING" && status === "ACTIVE"
            ? now
            : undefined,
        activatedAt: status === "ACTIVE" ? now : undefined,
        paidAt:
          status === "ACTIVE" && trialStatus !== "ACTIVE"
            ? now
            : undefined,
        failedAt: status === "FROZEN" ? now : undefined,
        frozenAt: status === "FROZEN" ? now : undefined,
        rawResponse: {
          subscriptionGid: gid,
          shopifyUpdatedAt: shopifyUpdatedAt?.toISOString() ?? null,
          status,
        },
      },
    });
  }

  if (
    shopPointer?.currentSubscriptionGid &&
    shopPointer.currentSubscriptionGid !== gid &&
    (status === "PENDING" || status === "DECLINED" || status === "EXPIRED")
  ) {
    await db.billingSubscription.update({
      where: {
        shopifySubscriptionGid: shopPointer.currentSubscriptionGid,
      },
      data: {
        planChangeStatus:
          status === "PENDING"
            ? "PENDING"
            : status === "DECLINED"
              ? "DECLINED"
              : "EXPIRED",
      },
    });
  }

  /**
   * Emit the complete matrix lifecycle. The Admin API state is authoritative;
   * event rows are immutable history and are idempotent by deterministic keys.
   */
  if (!current) {
    await recordBillingEvent({
      shop,
      subscriptionGid: gid,
      type: "MISSING_DB_RECORD",
      source,
      idempotencyKey: `missing-db-record:${gid}:${status}`,
      payload: {
        planHandle: inferred.planHandle,
        status,
      },
    });
  }

  if (!current && status === "PENDING") {
    await recordBillingEvent({
      shop,
      subscriptionGid: gid,
      type: "SUBSCRIPTION_CREATED",
      source,
      idempotencyKey: `subscription-created:${gid}`,
      payload: {
        planHandle: inferred.planHandle,
        status,
      },
    });
  }

  if (
    status === "ACTIVE" &&
    previousStatus !== "ACTIVE"
  ) {
    await recordBillingEvent({
      shop,
      subscriptionGid: gid,
      type:
        previousStatus === "FROZEN"
          ? "SUBSCRIPTION_UNFROZEN"
          : "SUBSCRIPTION_ACTIVATED",
      source,
      idempotencyKey:
        `subscription-${previousStatus === "FROZEN" ? "unfrozen" : "activated"}:${gid}`,
      payload: {
        planHandle: inferred.planHandle,
        previousStatus,
        status,
      },
    });

    if (previousStatus === "PENDING") {
      await recordBillingEvent({
        shop,
        subscriptionGid: gid,
        type: "SUBSCRIPTION_APPROVED",
        source,
        idempotencyKey: `subscription-approved:${gid}`,
        payload: {
          previousStatus,
          status,
        },
      });
    }

    if (replacementStatus === "APPLIED") {
      await recordBillingEvent({
        shop,
        subscriptionGid: gid,
        type: "PLAN_CHANGE_APPLIED",
        source,
        idempotencyKey: `plan-change-applied:${gid}`,
        payload: {
          previousPlanHandle: before.planHandle,
          planHandle: inferred.planHandle,
          previousStatus,
          status,
        },
      });

      const isUpgrade =
        previousPlanKey === AI_SEARCH_PLAN.basic &&
        inferred.plan === AI_SEARCH_PLAN.pro;
      const isDowngrade =
        previousPlanKey === AI_SEARCH_PLAN.pro &&
        inferred.plan === AI_SEARCH_PLAN.basic;

      if (isUpgrade || isDowngrade) {
        await recordBillingEvent({
          shop,
          subscriptionGid: gid,
          type: isUpgrade ? "PLAN_UPGRADE" : "PLAN_DOWNGRADE",
          source,
          idempotencyKey:
            `plan-change-${isUpgrade ? "upgrade" : "downgrade"}:${gid}`,
          payload: {
            previousPlanHandle: before.planHandle,
            planHandle: inferred.planHandle,
          },
        });
      }
    }

    if (
      source === "CALLBACK"
    ) {
      const priorWebhookActivation = await db.billingEvent.findFirst({
        where: {
          shop,
          subscriptionGid: gid,
          type: "SUBSCRIPTION_ACTIVATED",
          source: "WEBHOOK",
        },
        select: { id: true },
      });

      if (!priorWebhookActivation) {
        await recordBillingEvent({
          shop,
          subscriptionGid: gid,
          type: "REDIRECT_BEFORE_WEBHOOK",
          source,
          idempotencyKey: `redirect-before-webhook:${gid}`,
          payload: {
            reason: "CALLBACK_RECONCILED_BEFORE_SUBSCRIPTION_WEBHOOK",
          },
        });
      }
    }
  }

  if (
    status === "ACTIVE" &&
    trialStatus === "ACTIVE" &&
    previousTrialStatus !== "ACTIVE"
  ) {
    await recordBillingEvent({
      shop,
      subscriptionGid: gid,
      type: "TRIAL_STARTED",
      source,
      idempotencyKey: `trial-started:${gid}`,
      payload: {
        trialStartsAt: trialStartsAt?.toISOString() ?? null,
        trialEndsAt: trialEndsAt?.toISOString() ?? null,
        trialDays,
      },
    });
  }

  if (
    status === "ACTIVE" &&
    trialStatus === "ENDED" &&
    previousTrialStatus === "ACTIVE"
  ) {
    await recordBillingEvent({
      shop,
      subscriptionGid: gid,
      type: "TRIAL_ENDED",
      source,
      idempotencyKey:
        `trial-ended:${gid}:${trialEndsAt?.getTime() ?? "none"}`,
      payload: {
        trialEndsAt: trialEndsAt?.toISOString() ?? null,
      },
    });
  }

  if (
    current?.trialEndsAt &&
    trialEndsAt &&
    trialEndsAt.getTime() > current.trialEndsAt.getTime()
  ) {
    await recordBillingEvent({
      shop,
      subscriptionGid: gid,
      type: "TRIAL_EXTENDED",
      source,
      idempotencyKey: `trial-extended:${gid}:${trialEndsAt.getTime()}`,
      payload: {
        previousTrialEndsAt: current.trialEndsAt.toISOString(),
        trialEndsAt: trialEndsAt.toISOString(),
      },
    });
  }

  if (
    trialStatus === "CANCELLED" &&
    previousTrialStatus !== "CANCELLED"
  ) {
    await recordBillingEvent({
      shop,
      subscriptionGid: gid,
      type: "TRIAL_CANCELLED",
      source,
      idempotencyKey: `trial-cancelled:${gid}`,
      payload: {
        trialEndsAt: trialEndsAt?.toISOString() ?? null,
        status,
      },
    });
  }

  if (
    status === "FROZEN" &&
    previousStatus !== "FROZEN"
  ) {
    await recordBillingEvent({
      shop,
      subscriptionGid: gid,
      type: "SUBSCRIPTION_FROZEN",
      source,
      idempotencyKey: `subscription-frozen:${gid}`,
      payload: {
        planHandle: inferred.planHandle,
        previousStatus,
        status,
      },
    });

    await recordBillingEvent({
      shop,
      subscriptionGid: gid,
      type: "PAYMENT_FAILED",
      source,
      idempotencyKey: `payment-failed:${gid}`,
      payload: {
        previousStatus,
        status,
      },
    });
  }

  if (
    status === "ACTIVE" &&
    previousStatus === "FROZEN"
  ) {
    await recordBillingEvent({
      shop,
      subscriptionGid: gid,
      type: "PAYMENT_RECOVERED",
      source,
      idempotencyKey: `payment-recovered:${gid}`,
      payload: {
        previousStatus,
        status,
      },
    });
  }

  if (
    status === "PENDING" &&
    !current
  ) {
    await recordBillingEvent({
      shop,
      subscriptionGid: gid,
      type: "PLAN_CHANGE_REQUESTED",
      source,
      idempotencyKey: `plan-change-requested:${gid}`,
      payload: {
        previousPlanHandle: before.planHandle,
        planHandle: inferred.planHandle,
      },
    });
  }

  if (
    status === "DECLINED" &&
    previousStatus !== "DECLINED"
  ) {
    await recordBillingEvent({
      shop,
      subscriptionGid: gid,
      type: "SUBSCRIPTION_DECLINED",
      source,
      idempotencyKey: `subscription-declined:${gid}`,
      payload: {
        planHandle: inferred.planHandle,
        previousStatus,
        status,
      },
    });

    if (replacementStatus === "DECLINED") {
      await recordBillingEvent({
        shop,
        subscriptionGid: gid,
        type: "PLAN_CHANGE_DECLINED",
        source,
        idempotencyKey: `plan-change-declined:${gid}`,
        payload: {
          previousStatus,
          status,
          planHandle: inferred.planHandle,
        },
      });
    }
  }

  if (
    status === "EXPIRED" &&
    previousStatus !== "EXPIRED"
  ) {
    await recordBillingEvent({
      shop,
      subscriptionGid: gid,
      type: "SUBSCRIPTION_EXPIRED",
      source,
      idempotencyKey: `subscription-expired:${gid}`,
      payload: {
        planHandle: inferred.planHandle,
        previousStatus,
        status,
      },
    });

    if (replacementStatus === "EXPIRED") {
      await recordBillingEvent({
        shop,
        subscriptionGid: gid,
        type: "PLAN_CHANGE_EXPIRED",
        source,
        idempotencyKey: `plan-change-expired:${gid}`,
        payload: {
          previousStatus,
          status,
          planHandle: inferred.planHandle,
        },
      });
    }
  }

  if (
    status === "CANCELLED" &&
    previousStatus !== "CANCELLED"
  ) {
    await recordBillingEvent({
      shop,
      subscriptionGid: gid,
      type: "SUBSCRIPTION_CANCELLED",
      source,
      idempotencyKey: `subscription-cancelled:${gid}`,
      payload: {
        planHandle: inferred.planHandle,
        previousStatus,
        status,
      },
    });

    await recordBillingEvent({
      shop,
      subscriptionGid: gid,
      type: "CANCELLATION_EFFECTIVE",
      source,
      idempotencyKey: `cancellation-effective:${gid}`,
      payload: {
        previousStatus,
        status,
      },
    });
  }

  if (previousStatus !== status || before.planHandle !== inferred.planHandle) {
    await recordBillingEvent({
      shop,
      subscriptionGid: gid,
      type: "SUBSCRIPTION_UPDATED",
      source,
      idempotencyKey: `subscription-updated:${gid}:${shopifyUpdatedAt?.getTime() ?? now.getTime()}`,
      payload: {
        previousStatus,
        status,
        previousPlanHandle: before.planHandle,
        planHandle: inferred.planHandle,
        shopifyUpdatedAt: shopifyUpdatedAt?.toISOString() ?? null,
      },
    });
  }

  await recordBillingEvent({
    shop,
    subscriptionGid: gid,
    type: "BILLING_RECONCILED",
    source,
    idempotencyKey: `billing-reconcile:${gid}:${status}:${shopifyUpdatedAt?.getTime() ?? "none"}`,
    payload: {
      planId: plan.id,
      planHandle: inferred.planHandle,
      shopifyStatus: status,
      billingPeriodStart: start?.toISOString() ?? null,
      billingPeriodEnd: end?.toISOString() ?? null,
    },
  });

  /**
   * Current entitlement pointer:
   * - ACTIVE becomes current.
   * - PENDING/FROZEN keep their exact BillingSubscription state but do not
   *   replace the current ACTIVE entitlement pointer.
   * - terminal states clear the current pointer only when they refer to the
   *   current subscription.
   */
  if (status === "ACTIVE") {
    // The newly ACTIVE subscription becomes current. Clear the pending
    // pointer only when it points to this exact GID; do not erase another
    // pending flow that may have been created after this one.
    await db.$executeRaw`
      UPDATE \`AiSearchShop\`
      SET
        \`currentPlanHandle\` = ${inferred.planHandle},
        \`currentSubscriptionGid\` = ${gid},
        \`pendingPlanHandle\` = CASE
          WHEN \`pendingSubscriptionGid\` = ${gid} THEN NULL
          ELSE \`pendingPlanHandle\`
        END,
        \`pendingChangeAt\` = CASE
          WHEN \`pendingSubscriptionGid\` = ${gid} THEN NULL
          ELSE \`pendingChangeAt\`
        END,
        \`pendingSubscriptionGid\` = CASE
          WHEN \`pendingSubscriptionGid\` = ${gid} THEN NULL
          ELSE \`pendingSubscriptionGid\`
        END,
        \`updatedAt\` = UTC_TIMESTAMP(3)
      WHERE \`shop\` = ${shop}
    `;
  } else if (status === "PENDING") {
    await db.$executeRaw`
      UPDATE \`AiSearchShop\`
      SET
        \`pendingPlanHandle\` = ${inferred.planHandle},
        \`pendingSubscriptionGid\` = ${gid},
        \`pendingChangeAt\` = UTC_TIMESTAMP(3)
      WHERE \`shop\` = ${shop}
    `;
  } else if (
    status === "CANCELLED" ||
    status === "DECLINED" ||
    status === "EXPIRED"
  ) {
    // A terminal event for the pending subscription must clear only the
    // pending pointer. A terminal event for the current subscription clears
    // the current pointer, but must not manufacture cancellation for any
    // other GID.
    await db.$executeRaw`
      UPDATE \`AiSearchShop\`
      SET
        \`currentPlanHandle\` = CASE
          WHEN \`currentSubscriptionGid\` = ${gid} THEN NULL
          ELSE \`currentPlanHandle\`
        END,
        \`currentSubscriptionGid\` = CASE
          WHEN \`currentSubscriptionGid\` = ${gid} THEN NULL
          ELSE \`currentSubscriptionGid\`
        END,
        \`pendingPlanHandle\` = CASE
          WHEN \`pendingSubscriptionGid\` = ${gid} THEN NULL
          ELSE \`pendingPlanHandle\`
        END,
        \`pendingChangeAt\` = CASE
          WHEN \`pendingSubscriptionGid\` = ${gid} THEN NULL
          ELSE \`pendingChangeAt\`
        END,
        \`pendingSubscriptionGid\` = CASE
          WHEN \`pendingSubscriptionGid\` = ${gid} THEN NULL
          ELSE \`pendingSubscriptionGid\`
        END,
        \`updatedAt\` = UTC_TIMESTAMP(3)
      WHERE \`shop\` = ${shop}
    `;
  }

  const snapshot = await getSubscriptionSnapshot(shop);
      await mirrorBillingStateToLegacy(snapshot);

      return {
        configured: true as const,

        // Entitlement hiện tại của shop.
        // Ví dụ: BASIC ACTIVE trong lúc PRO mới đang PENDING.
        subscription: snapshot,

        // Subscription/GID vừa được Shopify reconcile.
        // Đây mới là trạng thái mà callback cần theo dõi.
        reconciledSubscription: {
          gid,
          plan: inferred.plan,
          planHandle: inferred.planHandle,
          status,
        },

        changed:
          before.plan !== snapshot.plan ||
          before.status !== snapshot.status ||
          before.planHandle !== snapshot.planHandle ||
          before.shopifySubscriptionId !== snapshot.shopifySubscriptionId,

        previousPlan: before.plan,
        previousStatus: before.status,
      };
}

/**
 * Main Manual Billing reconciliation entry point.
 *
 * Shopify Admin GraphQL is the source of truth. The expected GID is used
 * when callback/webhook reconciliation identifies a specific subscription.
 */
export async function reconcileShopifySubscriptionFromAdmin({
  shop,
  admin,
  expectedSubscriptionGid,
  preferredPlanHandle,
  authoritativePlanHandle,
  source = "API",
}: {
  shop: string;
  admin: AdminGraphqlClient;
  expectedSubscriptionGid?: string | null;
  preferredPlanHandle?: string | null;
  authoritativePlanHandle?: string | null;
  source?: "CALLBACK" | "WEBHOOK" | "API" | "RECONCILIATION";
}) {
  const subscription = await queryAdminSubscription(
    admin,
    expectedSubscriptionGid,
  );

  if (!subscription) {
    console.log(
      "[BILLING] Shopify subscription not found for reconciliation; local state unchanged:",
      {
        shop,
        expectedSubscriptionGid: expectedSubscriptionGid ?? null,
      },
    );

    if (expectedSubscriptionGid) {
      const local = await db.billingSubscription.findUnique({
        where: { shopifySubscriptionGid: expectedSubscriptionGid },
        select: {
          id: true,
          status: true,
          reconciliationStatus: true,
        },
      });

      if (local) {
        const checkedAt = new Date();
        await db.billingSubscription.update({
          where: { id: local.id },
          data: {
            reconciliationStatus: "MISMATCH",
            reconciliationCheckedAt: checkedAt,
            reconciliationReason: "SHOPIFY_SUBSCRIPTION_NOT_FOUND",
            repairRequiredAt: checkedAt,
          },
        });

        await recordBillingEvent({
          shop,
          subscriptionGid: expectedSubscriptionGid,
          type: "MISSING_SHOPIFY_RECORD",
          source,
          idempotencyKey: `missing-shopify-record:${expectedSubscriptionGid}`,
          payload: {
            previousStatus: local.status,
            reason: "SHOPIFY_SUBSCRIPTION_NOT_FOUND",
          },
        });

        await recordBillingEvent({
          shop,
          subscriptionGid: expectedSubscriptionGid,
          type: "DB_SHOPIFY_MISMATCH",
          source: "RECONCILIATION",
          idempotencyKey: `db-shopify-mismatch:${expectedSubscriptionGid}:${checkedAt.getTime()}`,
          payload: {
            previousStatus: local.status,
            reason: "SHOPIFY_SUBSCRIPTION_NOT_FOUND",
          },
        });

        console.warn("[BILLING MATRIX MISMATCH]", {
          shop,
          expectedSubscriptionGid,
          reason: "SHOPIFY_SUBSCRIPTION_NOT_FOUND",
          reconciliationStatus: "MISMATCH",
          repairRequiredAt: checkedAt.toISOString(),
        });
      }
    }

    return {
      configured: true as const,
      confirmed: false as const,
      changed: false,
      subscription: await getSubscriptionSnapshot(shop, {
        ensure: false,
      }),
      reconciledSubscription: null,
    };
  }

  console.log("[BILLING] Shopify subscription verified:", {
    shop,
    expectedSubscriptionGid: expectedSubscriptionGid ?? null,
    actualSubscriptionGid: subscription.id,
    status: subscription.status,
    name: subscription.name,
  });

  const result = await reconcileManualShopifySubscription({
    shop,
    admin,
    preferredPlanHandle,
    authoritativePlanHandle,
    adminSubscription: subscription,
    source,
  });

  return {
    ...result,
    configured: true as const,
    confirmed: true as const,
  };
}

/**
 * Compatibility wrapper retained for existing callers. The implementation
 * is Manual Billing and does not call Shopify Partner API.
 */
export async function refreshShopifyAppPricingSubscription({
  shop,
  admin,
  preferredPlanHandle,
  adminSubscription,
  source = "API",
}: {
  shop: string;
  admin: AdminGraphqlClient;
  preferredPlanHandle?: string | null;
  adminSubscription?: AdminSubscription | null;
  source?: "CALLBACK" | "WEBHOOK" | "API" | "RECONCILIATION";
}) {
  if (adminSubscription) {
    return reconcileManualShopifySubscription({
      shop,
      admin,
      preferredPlanHandle,
      adminSubscription,
      source,
    });
  }

  return reconcileShopifySubscriptionFromAdmin({
    shop,
    admin,
    expectedSubscriptionGid: null,
    preferredPlanHandle,
    source,
  });
}

export async function refreshShopifyAppPricingIfStale({
  shop,
  admin,
  preferredPlanHandle,
  maxAgeMs = 5 * 60_000,
  source = "RECONCILIATION",
}: {
  shop: string;
  admin: AdminGraphqlClient;
  preferredPlanHandle?: string | null;
  maxAgeMs?: number;
  source?: "CALLBACK" | "WEBHOOK" | "API" | "RECONCILIATION";
}) {
  const current = await getSubscriptionSnapshot(shop);

  if (current.source === "DEV_OVERRIDE" && hasExplicitDevPlanOverride()) {
    return {
      configured: false as const,
      subscription: current,
      skipped: true,
      changed: false,
      previousPlan: current.plan,
      previousStatus: current.status,
    };
  }

  const isStale = (snapshot: typeof current) =>
    !snapshot.lastSyncedAt ||
    Date.now() - snapshot.lastSyncedAt.getTime() >= maxAgeMs;

  if (!preferredPlanHandle && !isStale(current)) {
    return {
      configured: true as const,
      subscription: current,
      skipped: true,
      changed: false,
      previousPlan: current.plan,
      previousStatus: current.status,
    };
  }

  return withDistributedLease({
    shop,
    resource: "billing:refresh",
    leaseMs: 30_000,
    waitTimeoutMs: 10_000,
    pollMs: 100,
    task: async () => {
      const latest = await getSubscriptionSnapshot(shop);

      if (!preferredPlanHandle && !isStale(latest)) {
        return {
          configured: true as const,
          subscription: latest,
          skipped: true,
          changed: false,
          previousPlan: latest.plan,
          previousStatus: latest.status,
        };
      }

      const refreshed = await reconcileShopifySubscriptionFromAdmin({
        shop,
        admin,
        expectedSubscriptionGid:
          latest.shopifySubscriptionId ?? null,
        preferredPlanHandle,
        source,
      });

      return {
        ...refreshed,
        skipped: false,
      };
    },
  });
}
