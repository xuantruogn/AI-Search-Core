import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import {
  getShopifyPricingPlansUrl,
  isShopifyAppPricingConfigured,
  refreshShopifyAppPricingSubscription,
  reconcileShopifySubscriptionFromAdmin,
} from "../services/billing/shopify-app-pricing.server";
import { getShopEntitlement } from "../services/commerce/entitlement.server";
import { getSubscriptionSnapshot } from "../services/commerce/shop-registry.server";
import { reconcileShopCommercialState } from "../services/commerce/reconciliation.server";
import { setBillingPlanChangeState } from "../services/commerce/billing-state.server";

function planPresentation(featureFlags: unknown) {
  const flags =
    featureFlags && typeof featureFlags === "object"
      ? (featureFlags as {
          description?: string;
          highlights?: string[];
          capabilities?: Record<string, boolean>;
        })
      : {};

  const highlights = Array.isArray(flags.highlights)
    ? flags.highlights.filter((value): value is string => typeof value === "string")
    : [];

  const capabilities = flags.capabilities ?? {};
  const capabilityLabels = Object.entries(capabilities)
    .filter(([, enabled]) => enabled === true)
    .map(([key]) => key);

  return {
    description:
      typeof flags.description === "string" ? flags.description : "",
    highlights,
    capabilityLabels,
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const debugId = crypto.randomUUID().slice(0, 8);
  console.log("[BILLING TRACE] loader:start", {
    debugId,
    method: request.method,
    url: request.url,
    referer: request.headers.get("referer"),
    remixRequest: request.headers.get("x-remix-request"),
    secFetchMode: request.headers.get("sec-fetch-mode"),
  });

  const { session } = await authenticate.admin(request);
  console.log("[BILLING DEBUG] loader:authenticated", {
    debugId,
    shop: session.shop,
  });

  const entitlement = await getShopEntitlement(session.shop);
  const subscription = await getSubscriptionSnapshot(session.shop, {
    ensure: false,
  });

  const billingPlans = await db.plan.findMany({
    where: {
      isActive: true,
      visibility: "PUBLIC",
      billingMode: "MANUAL_BILLING",
      handle: { not: "custom" },
    },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: {
      id: true,
      handle: true,
      name: true,
      price: true,
      currencyCode: true,
      interval: true,
      trialDays: true,
      maxIndexedProducts: true,
      maxMonthlySearches: true,
      maxMonthlyVectorUpdates: true,
      featureFlags: true,
    },
  });

  const hasEverApprovedSubscription = Boolean(
    await db.billingEvent.findFirst({
      where: {
        shop: session.shop,
        type: "SUBSCRIPTION_APPROVED",
      },
      select: { id: true },
    }),
  );

  const customAssignment = await db.planAssignment.findFirst({
    where: {
      shop: session.shop,
      isActive: true,
      OR: [{ startsAt: null }, { startsAt: { lte: new Date() } }],
      plan: {
        handle: "custom",
      },
    },
    include: { plan: true },
    orderBy: { createdAt: "desc" },
  });

  const customTerms = customAssignment?.plan
    ? {
        planId: customAssignment.plan.id,
        handle: customAssignment.plan.handle,
        name: customAssignment.plan.name,
        price:
          customAssignment.customPriceOverride ??
          customAssignment.plan.price,
        currencyCode: customAssignment.plan.currencyCode,
        interval: customAssignment.plan.interval,
        trialDays: customAssignment.plan.trialDays,
        features: planPresentation(customAssignment.plan.featureFlags),
        limits: {
          productLimit:
            customAssignment.customMaxIndexedProducts ??
            customAssignment.plan.maxIndexedProducts,
          searchLimit:
            customAssignment.customMaxMonthlySearches ??
            customAssignment.plan.maxMonthlySearches,
          vectorUpdateLimit:
            customAssignment.customMaxMonthlyVectorUpdates ??
            customAssignment.plan.maxMonthlyVectorUpdates,
        },
        usageBillingEnabled:
          customAssignment.plan.usageBillingEnabled,
      }
    : null;

  let daysRemaining: number | null = null;
  let formattedPeriodEnd: string | null = null;

  if (subscription.billingPeriodEnd) {
    const endDate = new Date(subscription.billingPeriodEnd);
    const now = new Date();
    const diffTime = endDate.getTime() - now.getTime();
    daysRemaining = Math.max(
      0,
      Math.ceil(diffTime / (1000 * 60 * 60 * 24)),
    );
    formattedPeriodEnd = endDate.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  return {
    shop: session.shop,
    entitlement,
    subscription: {
      ...subscription,
      billingPeriodStart:
        subscription.billingPeriodStart?.toISOString() ?? null,
      billingPeriodEnd:
        subscription.billingPeriodEnd?.toISOString() ?? null,
      lastSyncedAt: subscription.lastSyncedAt?.toISOString() ?? null,
      daysRemaining,
      formattedPeriodEnd,
    },
    pricingUrl: getShopifyPricingPlansUrl(session.shop),
    partnerApiConfigured: isShopifyAppPricingConfigured(),
    plans: billingPlans.map((plan) => {
      const presentation = planPresentation(plan.featureFlags);
      const isBasic = plan.handle.toLowerCase() === "basic";
      const isActiveBasicTrial =
        isBasic &&
        subscription.plan === "BASIC" &&
        subscription.trialStatus === "ACTIVE";

      return {
        id: plan.id,
        key: plan.handle.toUpperCase(),
        handle: plan.handle,
        label: plan.name,
        name: plan.name,
        price: Number(plan.price),
        currencyCode: plan.currencyCode,
        interval: plan.interval,
        trialDays:
          isBasic &&
          (isActiveBasicTrial || !hasEverApprovedSubscription)
            ? plan.trialDays
            : 0,
        description: presentation.description,
        highlights: presentation.highlights,
        capabilityLabels: presentation.capabilityLabels,
        limits: {
          productLimit: plan.maxIndexedProducts,
          searchLimit: plan.maxMonthlySearches,
          vectorUpdateLimit: plan.maxMonthlyVectorUpdates,
        },
        featureFlags: plan.featureFlags,
      };
    }),
    customPlan:
      customTerms && customTerms.price !== null
        ? {
            id: customTerms.planId,
            handle: customTerms.handle,
            key: customTerms.handle.toUpperCase(),
            label: customTerms.name,
            name: customTerms.name,
            price: Number(customTerms.price),
            currencyCode: customTerms.currencyCode,
            interval: customTerms.interval,
            trialDays: 0,
            description: customTerms.features.description,
            highlights: customTerms.features.highlights,
            capabilityLabels: customTerms.features.capabilityLabels,
            limits: customTerms.limits,
            usageBillingEnabled: customTerms.usageBillingEnabled,
          }
        : null,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const debugId = crypto.randomUUID().slice(0, 8);
  console.log("[BILLING DEBUG] action:start", {
    debugId,
    method: request.method,
    url: request.url,
  });

  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  console.log("[BILLING DEBUG] action:authenticated", {
    debugId,
    shop: session.shop,
    intent,
  });

  if (intent === "refresh") {
    try {
      const result = await refreshShopifyAppPricingSubscription({
        shop: session.shop,
        admin,
      });

      const reconciliation = await reconcileShopCommercialState({
        shop: session.shop,
        forceCatalogRefresh: result.changed,
      });

      return {
        success: true,
        message: result.configured
          ? `Billing synced: ${result.subscription.plan} / ${result.subscription.status}. Reconcile: pruned ${reconciliation.pruned}, recovered ${reconciliation.recovered}.`
          : "Partner API not configured; using local/dev subscription state.",
      };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (intent === "cancelRenewal") {
    try {
      console.log("[BILLING DEBUG] cancel:start", {
        debugId,
        shop: session.shop,
      });

      const snapshot = await getSubscriptionSnapshot(session.shop, {
        ensure: false,
      });

      const subscriptionGid = snapshot.shopifySubscriptionId;

      if (!subscriptionGid) {
        return {
          success: false,
          message: "No active Shopify subscription was found.",
        };
      }

      if (snapshot.cancellationStatus === "NON_RENEWING") {
        return {
          success: true,
          message:
            "This subscription is already set not to renew for the next cycle.",
        };
      }

      if (snapshot.status !== "ACTIVE") {
        return {
          success: false,
          message: `This subscription cannot be set to stop renewal from its current status: ${snapshot.status}.`,
        };
      }

      const response = await admin.graphql(
        `#graphql
        mutation CancelAppSubscription($id: ID!, $prorate: Boolean) {
          appSubscriptionCancel(id: $id, prorate: $prorate) {
            userErrors { field message }
            appSubscription {
              id
              status
            }
          }
        }`,
        {
          variables: {
            id: subscriptionGid,
            prorate: false,
          },
        },
      );

      const payload = (await response.json()) as {
        data?: {
          appSubscriptionCancel?: {
            userErrors?: Array<{ field?: string[]; message?: string }>;
            appSubscription?: {
              id?: string;
              status?: string;
            } | null;
          };
        };
        errors?: Array<{ message?: string }>;
      };

      const userErrors = payload.data?.appSubscriptionCancel?.userErrors ?? [];
      const graphQLErrors = payload.errors ?? [];

      if (graphQLErrors.length || userErrors.length) {
        const message = [
          ...graphQLErrors.map((error) => error.message).filter(Boolean),
          ...userErrors.map((error) => error.message).filter(Boolean),
        ].join("; ");

        return {
          success: false,
          message:
            message ||
            "Shopify could not stop the next subscription renewal.",
        };
      }

      const cancelled = payload.data?.appSubscriptionCancel?.appSubscription;

      if (!cancelled?.id) {
        return {
          success: false,
          message: "Shopify did not return the cancelled subscription.",
        };
      }

      const reconciliation = await reconcileShopifySubscriptionFromAdmin({
        shop: session.shop,
        admin,
        expectedSubscriptionGid: cancelled.id,
        preferredPlanHandle: snapshot.planHandle,
        authoritativePlanHandle: snapshot.planHandle,
        source: "API",
        observedShopifyStatus: "CANCELLED",
      });

      console.log("[BILLING DEBUG] cancel:reconcile:done", {
        debugId,
        shop: session.shop,
        plan: reconciliation.subscription.plan,
        status: reconciliation.subscription.status,
        cancellationStatus: reconciliation.subscription.cancellationStatus,
        accessStatus: reconciliation.subscription.accessStatus,
        commercialStatus: reconciliation.subscription.commercialStatus,
      });

      return {
        success: true,
        renewalDisabled: true,
        message:
          "Automatic renewal is off. Your current plan remains available until the end of the paid billing period.",
      };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (intent === "subscribe") {
    const planHandle = String(form.get("planHandle") || "")
      .trim()
      .toLowerCase();

    const requestedReplacementBehavior = String(
      form.get("replacementBehavior") || "APPLY_IMMEDIATELY",
    );

    const replacementBehavior =
      requestedReplacementBehavior === "APPLY_ON_NEXT_BILLING_CYCLE"
        ? "APPLY_ON_NEXT_BILLING_CYCLE"
        : requestedReplacementBehavior === "STANDARD"
          ? "STANDARD"
          : "APPLY_IMMEDIATELY";

    const customAssignment =
      planHandle === "custom"
        ? await db.planAssignment.findFirst({
            where: {
              shop: session.shop,
              isActive: true,
              OR: [{ startsAt: null }, { startsAt: { lte: new Date() } }],
              plan: { handle: "custom" },
            },
            include: { plan: true },
            orderBy: { createdAt: "desc" },
          })
        : null;

    const billingPlan =
      planHandle === "custom"
        ? customAssignment?.plan ?? null
        : await db.plan.findFirst({
            where: {
              handle: planHandle,
              isActive: true,
              visibility: "PUBLIC",
              billingMode: "MANUAL_BILLING",
            },
          });

    if (
      !billingPlan ||
      (planHandle === "custom" && !customAssignment)
    ) {
      return {
        success: false,
        message: "This plan is not available for purchase.",
      };
    }

    const hasEverApprovedSubscription = Boolean(
      await db.billingEvent.findFirst({
        where: {
          shop: session.shop,
          type: "SUBSCRIPTION_APPROVED",
        },
        select: { id: true },
      }),
    );

    const isBasicPlan = billingPlan.handle.toLowerCase() === "basic";
    const trialDays =
      isBasicPlan && !hasEverApprovedSubscription
        ? Math.max(0, billingPlan.trialDays ?? 0)
        : 0;

    const billingTestMode =
      String(process.env.BILLING_TEST_MODE ?? "")
        .trim()
        .toLowerCase() === "true";

    const finalPrice =
      customAssignment?.customPriceOverride ??
      Number(billingPlan.price);

    const billingInterval = billingPlan.interval;
    const currencyCode = billingPlan.currencyCode;
    const planName = `AI Search ${billingPlan.name} Plan`;

    try {
      const shopHandle = session.shop.replace(/\.myshopify\.com$/i, "");
      const appIdentifier =
        process.env.SHOPIFY_APP_HANDLE?.trim() ||
        process.env.SHOPIFY_API_KEY?.trim();

      if (!appIdentifier) {
        throw new Error("Shopify app identifier is not configured.");
      }

      const returnUrl = new URL(
        `https://admin.shopify.com/store/${encodeURIComponent(
          shopHandle,
        )}/apps/${encodeURIComponent(
          appIdentifier,
        )}/app/billing`,
      );
      returnUrl.searchParams.set("billing_callback", "1");

      const response = await admin.graphql(
        `#graphql
        mutation createPaymentLink(
          $name: String!,
          $price: Decimal!,
          $returnUrl: URL!,
          $test: Boolean,
          $trialDays: Int,
          $interval: AppPricingInterval!,
          $currencyCode: CurrencyCode!,
          $replacementBehavior: AppSubscriptionReplacementBehavior
        ) {
          appSubscriptionCreate(
            name: $name
            returnUrl: $returnUrl
            test: $test
            trialDays: $trialDays
            replacementBehavior: $replacementBehavior
            lineItems: [{
              plan: {
                appRecurringPricingDetails: {
                  price: { amount: $price, currencyCode: $currencyCode }
                  interval: $interval
                }
              }
            }]
          ) {
            userErrors { field message }
            confirmationUrl
            appSubscription {
              id
              status
              createdAt
            }
          }
        }`,
        {
          variables: {
            name: planName,
            price: finalPrice.toFixed(2),
            returnUrl: returnUrl.toString(),
            test: billingTestMode,
            trialDays: trialDays > 0 ? trialDays : null,
            interval: billingInterval,
            currencyCode,
            replacementBehavior,
          },
        },
      );

      const responseJson = (await response.json()) as {
        data?: {
          appSubscriptionCreate?: {
            userErrors?: Array<{ field?: string[]; message?: string }>;
            confirmationUrl?: string | null;
            appSubscription?: {
              id?: string;
              status?: string;
              createdAt?: string;
            } | null;
          };
        };
        errors?: Array<{ message?: string }>;
      };

      const subscriptionData = responseJson.data?.appSubscriptionCreate;

      if (subscriptionData?.userErrors?.length) {
        const errorMsg = subscriptionData.userErrors
          .map((error) => error.message)
          .filter(Boolean)
          .join(", ");

        return {
          success: false,
          message: errorMsg
            ? `Shopify Error: ${errorMsg}`
            : "Shopify could not create the subscription.",
        };
      }

      const createdSubscription = subscriptionData?.appSubscription;

      if (!createdSubscription?.id) {
        return {
          success: false,
          message: "Shopify did not return subscription ID.",
        };
      }

      await db.aiSearchShop.update({
        where: { shop: session.shop },
        data: {
          pendingPlanHandle: billingPlan.handle,
          pendingSubscriptionGid: createdSubscription.id,
        },
      });

      await reconcileShopifySubscriptionFromAdmin({
        shop: session.shop,
        admin,
        expectedSubscriptionGid: createdSubscription.id,
        preferredPlanHandle: billingPlan.handle,
        authoritativePlanHandle: billingPlan.handle,
        source: "CALLBACK",
      });

      if (replacementBehavior === "APPLY_ON_NEXT_BILLING_CYCLE") {
        await setBillingPlanChangeState({
          shop: session.shop,
          subscriptionGid: createdSubscription.id,
          status: "DEFERRED",
          source: "CALLBACK",
          reason:
            "APP_SUBSCRIPTION_REPLACEMENT_BEHAVIOR_APPLY_ON_NEXT_BILLING_CYCLE",
        });
      }

      const confirmationUrl = subscriptionData?.confirmationUrl;

      if (confirmationUrl) {
        return {
          success: true,
          confirmationUrl,
        };
      }

      return {
        success: false,
        message: "Failed to create payment link.",
      };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    success: false,
    message: "Invalid action intent",
  };
};

function limitText(value: number | null, suffix: string) {
  return value === null
    ? `Unlimited ${suffix}`
    : `${value.toLocaleString("en-US")} ${suffix}`;
}

type Cycle = "monthly" | "yearly";

export default function BillingPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const subscribeFetcher = useFetcher<typeof action>();
  const cancelFetcher = useFetcher<typeof action>();

  useEffect(() => {
    console.log("[BILLING TRACE] cancelFetcher:state", {
      state: cancelFetcher.state,
      hasData: Boolean(cancelFetcher.data),
      renewalDisabled: cancelFetcher.data?.renewalDisabled ?? false,
    });
  }, [cancelFetcher.state, cancelFetcher.data]);

  if (!data) return null;

  const [cycle, setCycle] = useState<Cycle>("monthly");
  const [customRequestSent, setCustomRequestSent] = useState(false);
  const [customShowForm, setCustomShowForm] = useState(false);

  useEffect(() => {
    if (subscribeFetcher.data?.confirmationUrl) {
      console.log(
        "[BILLING CLIENT REDIRECT] Redirecting top location to confirmationUrl",
      );
      window.top!.location.href = subscribeFetcher.data.confirmationUrl;
    }
  }, [subscribeFetcher.data]);

  const cycleDiscount = {
    monthly: 0,
    yearly: 0.2,
  };

  const cycleText = {
    monthly: "/month",
    yearly: "/month (billed annually)",
  };

  const currentPlanKey =
    data.entitlement.planLabel?.toUpperCase() || "NONE";
  const isNonRenewing =
    data.entitlement.cancellationStatus === "NON_RENEWING";
  const isActive =
    data.entitlement.subscriptionStatus === "ACTIVE" || isNonRenewing;

  const availablePlans = data.customPlan
    ? [...data.plans, data.customPlan]
    : data.plans;

  return (
    <div
      style={{
        width: "100%",
        padding: "20px 24px 60px 24px",
        boxSizing: "border-box",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: 12,
          padding: 20,
          border: "1px solid #e1e3e5",
          marginBottom: 24,
          boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 16,
          }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: 17,
              fontWeight: 700,
              color: "#1a1a1a",
            }}
          >
            Current Subscription Status
          </h2>
          <span
            style={{
              padding: "4px 12px",
              borderRadius: 20,
              fontSize: 12,
              fontWeight: 700,
              background: isActive ? "#e4f8f0" : "#ffebe9",
              color: isActive ? "#008060" : "#d32f2f",
            }}
          >
            {isNonRenewing
              ? "ACTIVE — NOT RENEWING"
              : isActive
                ? "ACTIVE (PAID)"
                : data.entitlement.subscriptionStatus}
          </span>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: 16,
            fontSize: 13,
            color: "#4a4a4a",
          }}
        >
          <div>
            <strong>Store:</strong> {data.shop}
          </div>
          <div>
            <strong>Current Plan:</strong> {data.entitlement.planLabel}
          </div>
          <div>
            <strong>Billing Cycle:</strong>{" "}
            {data.subscription.formattedPeriodEnd
              ? `${data.subscription.billingInterval === "ANNUAL" ? "Annual" : "Monthly"} — ${data.subscription.formattedPeriodEnd} (${data.subscription.daysRemaining} days left)`
              : "No active billing period"}
          </div>
          <div>
            <strong>Source:</strong> {data.subscription.source}
          </div>
          <div>
            <strong>Partner API:</strong>{" "}
            {data.partnerApiConfigured ? "🟢 Connected" : "🔴 Not Configured"}
          </div>
        </div>

        <div
          style={{
            marginTop: 16,
            paddingTop: 14,
            borderTop: "1px solid #f1f2f3",
            display: "flex",
            gap: 16,
            alignItems: "center",
          }}
        >
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="refresh" />
            <button
              type="submit"
              disabled={fetcher.state !== "idle"}
              style={{
                padding: "8px 16px",
                borderRadius: 8,
                border: "1px solid #c9cccf",
                background: "#fff",
                fontWeight: 600,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              {fetcher.state !== "idle" ? "Syncing..." : "Sync Billing Status"}
            </button>
          </fetcher.Form>

          {data.pricingUrl && (
            <a
              href={data.pricingUrl}
              target="_top"
              style={{
                color: "#2c6ecb",
                fontSize: 13,
                fontWeight: 600,
                textDecoration: "none",
              }}
            >
              Open Shopify Subscription Manager →
            </a>
          )}
        </div>

        {isActive ? (
          <div
            style={{
              marginTop: 14,
              padding: 14,
              borderRadius: 10,
              background: isNonRenewing ? "#fff8e6" : "#f3faf7",
              border: `1px solid ${
                isNonRenewing ? "#f0d98a" : "#cfe9df"
              }`,
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 13, color: "#1a1a1a" }}>
              Renewal
            </div>
            <div style={{ fontSize: 12, color: "#4a4a4a", marginTop: 6 }}>
              {isNonRenewing
                ? `Automatic renewal is off. Your ${data.entitlement.planLabel} plan remains available until ${data.subscription.formattedPeriodEnd ?? "the end of the current billing period"}.`
                : "Automatic renewal is on. Shopify will continue the subscription at the next billing cycle unless you choose to stop renewal."}
            </div>

            <cancelFetcher.Form method="post" style={{ marginTop: 12 }}>
              <input type="hidden" name="intent" value="cancelRenewal" />
              <fieldset
                disabled={cancelFetcher.state !== "idle" || isNonRenewing}
                style={{
                  margin: 0,
                  padding: 0,
                  border: 0,
                  display: "grid",
                  gap: 8,
                }}
              >
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 12,
                    color: "#1a1a1a",
                  }}
                >
                  <input
                    type="radio"
                    name="renewalChoice"
                    value="automatic"
                    checked={!isNonRenewing}
                    readOnly
                  />
                  <span>
                    <strong>Automatic renewal</strong>
                    <span
                      style={{
                        display: "block",
                        color: "#6b6b6b",
                        marginTop: 2,
                      }}
                    >
                      Continue this subscription into the next billing cycle.
                    </span>
                  </span>
                </label>

                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 12,
                    color: isNonRenewing ? "#8a1c1c" : "#1a1a1a",
                  }}
                >
                  <input
                    type="radio"
                    name="renewalChoice"
                    value="stop"
                    checked={isNonRenewing}
                    disabled={isNonRenewing}
                    onChange={(event) => {
                      if (
                        !event.target.checked ||
                        cancelFetcher.state !== "idle"
                      ) {
                        return;
                      }

                      const confirmed = window.confirm(
                        `Are you sure you want to turn off automatic renewal? Your current ${data.entitlement.planLabel} plan will remain active until ${data.subscription.formattedPeriodEnd ?? "the end of the current billing period"}, then it will end and will not renew automatically.`,
                      );

                      if (confirmed) {
                        event.currentTarget.form?.requestSubmit();
                      } else {
                        event.currentTarget.checked = false;
                      }
                    }}
                  />
                  <span>
                    <strong>Do not renew next period</strong>
                    <span
                      style={{
                        display: "block",
                        color: "#6b6b6b",
                        marginTop: 2,
                      }}
                    >
                      Keep the current plan active until the end of this
                      billing period.
                    </span>
                  </span>
                </label>
              </fieldset>
            </cancelFetcher.Form>

            {cancelFetcher.data?.message ? (
              <p
                style={{
                  margin: "8px 0 0 0",
                  fontSize: 12,
                  color: cancelFetcher.data.success ? "#008060" : "#d32f2f",
                }}
              >
                {cancelFetcher.data.message}
              </p>
            ) : null}
          </div>
        ) : null}

        {fetcher.data?.message ? (
          <p
            style={{
              margin: "10px 0 0 0",
              fontSize: 12,
              color: fetcher.data.success ? "#008060" : "#d32f2f",
            }}
          >
            {fetcher.data.message}
          </p>
        ) : null}
      </div>

      <div
        style={{
          background: "#fff",
          borderRadius: 12,
          padding: 20,
          border: "1px solid #e1e3e5",
          marginBottom: 32,
          boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
        }}
      >
        <h3
          style={{
            margin: "0 0 14px 0",
            fontSize: 15,
            fontWeight: 700,
            color: "#1a1a1a",
          }}
        >
          📊 Usage & Capacity this Period
        </h3>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 16,
          }}
        >
          <div
            style={{
              border: "1px solid #f1f2f3",
              borderRadius: 8,
              padding: 14,
              background: "#fafafa",
            }}
          >
            <div
              style={{ fontSize: 12, color: "#616161", marginBottom: 4 }}
            >
              AI Searches
            </div>
            <div
              style={{
                fontSize: 18,
                fontWeight: 700,
                color: "#1a1a1a",
              }}
            >
              {data.entitlement.usage.searchCount.toLocaleString("en-US")} /{" "}
              {limitText(data.entitlement.limits.searchLimit, "")}
            </div>
            <div style={{ fontSize: 11, color: "#008060", marginTop: 4 }}>
              Auto-fallbacks to Shopify Search when limit reached
            </div>
          </div>

          <div
            style={{
              border: "1px solid #f1f2f3",
              borderRadius: 8,
              padding: 14,
              background: "#fafafa",
            }}
          >
            <div
              style={{ fontSize: 12, color: "#616161", marginBottom: 4 }}
            >
              AI Indexed Products
            </div>
            <div
              style={{
                fontSize: 18,
                fontWeight: 700,
                color: "#1a1a1a",
              }}
            >
              {data.entitlement.indexedProducts.toLocaleString("en-US")} /{" "}
              {limitText(data.entitlement.limits.productLimit, "")}
            </div>
            <div style={{ fontSize: 11, color: "#616161", marginTop: 4 }}>
              Products ready for AI ranking
            </div>
          </div>

          <div
            style={{
              border: "1px solid #f1f2f3",
              borderRadius: 8,
              padding: 14,
              background: "#fafafa",
            }}
          >
            <div
              style={{ fontSize: 12, color: "#616161", marginBottom: 4 }}
            >
              Vector Updates
            </div>
            <div
              style={{
                fontSize: 18,
                fontWeight: 700,
                color: "#1a1a1a",
              }}
            >
              {data.entitlement.usage.vectorUpdateCount.toLocaleString(
                "en-US",
              )} /{" "}
              {limitText(
                data.entitlement.limits.vectorUpdateLimit,
                "",
              )}
            </div>
            <div style={{ fontSize: 11, color: "#616161", marginTop: 4 }}>
              Vector data update executions
            </div>
          </div>
        </div>
      </div>

      <div style={{ textAlign: "center", marginBottom: 32 }}>
        <h1
          style={{
            fontSize: 26,
            fontWeight: 800,
            color: "#1a1a1a",
            margin: "0 0 8px 0",
          }}
        >
          Choose the Right Plan for Your Store
        </h1>
        <p
          style={{
            color: "#616161",
            fontSize: 14,
            margin: "0 0 20px 0",
          }}
        >
          Optimize AI search experiences and boost sales conversion rates
          today.
        </p>

        <div
          style={{
            display: "inline-flex",
            background: "#f1f2f3",
            padding: 4,
            borderRadius: 10,
            gap: 4,
          }}
        >
          <button
            type="button"
            onClick={() => setCycle("monthly")}
            style={{
              padding: "8px 20px",
              borderRadius: 8,
              border: "none",
              background: cycle === "monthly" ? "#fff" : "transparent",
              fontWeight: 600,
              fontSize: 13,
              color: cycle === "monthly" ? "#1a1a1a" : "#616161",
              cursor: "pointer",
              boxShadow:
                cycle === "monthly"
                  ? "0 1px 3px rgba(0,0,0,0.1)"
                  : "none",
            }}
          >
            Monthly
          </button>
          <button
            type="button"
            onClick={() => setCycle("yearly")}
            style={{
              padding: "8px 20px",
              borderRadius: 8,
              border: "none",
              background: cycle === "yearly" ? "#fff" : "transparent",
              fontWeight: 600,
              fontSize: 13,
              color: cycle === "yearly" ? "#1a1a1a" : "#616161",
              cursor: "pointer",
              boxShadow:
                cycle === "yearly"
                  ? "0 1px 3px rgba(0,0,0,0.1)"
                  : "none",
            }}
          >
            Yearly <span style={{ color: "#008060", fontSize: 11 }}>(Save 20%)</span>
          </button>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "center",
          gap: 24,
          flexWrap: "wrap",
          maxWidth: 960,
          margin: "0 auto",
        }}
      >
        {availablePlans.map((plan) => (
          <div
            key={plan.id}
            style={{
              background: "#fff",
              borderRadius: 16,
              border: "1px solid #e1e3e5",
              padding: 28,
              width: "100%",
              maxWidth: 420,
              boxSizing: "border-box",
              boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
            }}
          >
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: "#616161",
                marginBottom: 10,
                textTransform: "uppercase",
              }}
            >
              {plan.handle}
            </div>

            <h2
              style={{
                margin: "0 0 8px 0",
                fontSize: 22,
                fontWeight: 800,
                color: "#1a1a1a",
              }}
            >
              {plan.name}
            </h2>

            <p
              style={{
                margin: "0 0 20px 0",
                fontSize: 13,
                color: "#616161",
                minHeight: 36,
              }}
            >
              {plan.description}
            </p>

            <div style={{ marginBottom: 20 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 6,
                }}
              >
                <span
                  style={{
                    fontSize: 36,
                    fontWeight: 800,
                    color: "#1a1a1a",
                  }}
                >
                  {plan.currencyCode === "USD"
                    ? "$"
                    : plan.currencyCode}{" "}
                  {plan.price.toFixed(2)}
                </span>
                <span style={{ fontSize: 13, color: "#616161" }}>
                  {plan.interval === "ANNUAL"
                    ? "/year"
                    : "/30 days"}
                </span>
              </div>

              {plan.trialDays > 0 && (
                <div
                  style={{
                    fontSize: 12,
                    color: "#008060",
                    fontWeight: 700,
                    marginTop: 6,
                  }}
                >
                  {plan.trialDays}-day free trial
                </div>
              )}

              {plan.highlights.length > 0 && (
                <div style={{ marginTop: 10, fontSize: 12, color: "#616161" }}>
                  {plan.highlights.join(" • ")}
                </div>
              )}
            </div>

            <subscribeFetcher.Form
              method="post"
              style={{ marginBottom: 24 }}
            >
              <input type="hidden" name="intent" value="subscribe" />
              <input type="hidden" name="planHandle" value={plan.handle} />

              <button
                type="submit"
                disabled={
                  plan.handle.toUpperCase() === currentPlanKey ||
                  subscribeFetcher.state !== "idle"
                }
                style={{
                  width: "100%",
                  textAlign: "center",
                  background:
                    plan.handle.toUpperCase() === currentPlanKey
                      ? "#8c9196"
                      : "#008060",
                  color: "#fff",
                  padding: "12px 20px",
                  borderRadius: 10,
                  fontWeight: 700,
                  fontSize: 14,
                  border: "none",
                  cursor:
                    plan.handle.toUpperCase() === currentPlanKey
                      ? "not-allowed"
                      : "pointer",
                }}
              >
                {plan.handle.toUpperCase() === currentPlanKey
                  ? "Your Current Plan"
                  : subscribeFetcher.state !== "idle"
                    ? "Redirecting..."
                    : `Choose ${plan.name}`}
              </button>
            </subscribeFetcher.Form>

            <div
              style={{
                borderTop: "1px solid #f1f2f3",
                paddingTop: 20,
                fontSize: 13,
              }}
            >
              <div
                style={{
                  fontWeight: 700,
                  color: "#1a1a1a",
                  marginBottom: 12,
                }}
              >
                Features Included:
              </div>

              <ul
                style={{
                  listStyle: "none",
                  padding: 0,
                  margin: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                }}
              >
                {plan.capabilityLabels.map((feature) => (
                  <li
                    key={feature}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 8,
                      color: "#4a4a4a",
                    }}
                  >
                    <span style={{ color: "#008060", fontWeight: "bold" }}>
                      ✓
                    </span>
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ))}
      </div>

      <div
        style={{
          maxWidth: 960,
          margin: "40px auto 0 auto",
          padding: 28,
          background: "#fff",
          borderRadius: 16,
          border: "1px solid #e1e3e5",
          boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
        }}
      >
        {!customRequestSent ? (
          <>
            <div style={{ textAlign: "center", marginBottom: 20 }}>
              <div
                style={{
                  display: "inline-block",
                  padding: "5px 10px",
                  borderRadius: 999,
                  background: "#f1f2f3",
                  color: "#4a4a4a",
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: "uppercase",
                }}
              >
                Custom Plan
              </div>
              <h2
                style={{
                  margin: "12px 0 8px 0",
                  fontSize: 22,
                  fontWeight: 800,
                  color: "#1a1a1a",
                }}
              >
                Need a plan tailored to your store?
              </h2>
              <p
                style={{
                  margin: 0,
                  color: "#616161",
                  fontSize: 13,
                  lineHeight: 1.6,
                }}
              >
                Tell us what you need. Our team will review your requirements,
                discuss the plan and pricing with you, and send a Shopify
                payment link after you agree to the offer.
              </p>
            </div>

            {!customShowForm ? (
              <div style={{ textAlign: "center" }}>
                <button
                  type="button"
                  onClick={() => setCustomShowForm(true)}
                  style={{
                    padding: "12px 24px",
                    borderRadius: 10,
                    border: "none",
                    background: "#1a1a1a",
                    color: "#fff",
                    fontWeight: 700,
                    fontSize: 14,
                    cursor: "pointer",
                  }}
                >
                  Request a Custom Plan
                </button>
              </div>
            ) : (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  setCustomRequestSent(true);
                }}
                style={{
                  maxWidth: 680,
                  margin: "0 auto",
                  display: "flex",
                  flexDirection: "column",
                  gap: 14,
                }}
              >
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "repeat(auto-fit, minmax(220px, 1fr))",
                    gap: 14,
                  }}
                >
                  <label
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: "#4a4a4a",
                    }}
                  >
                    Store
                    <input
                      value={data.shop}
                      readOnly
                      style={{
                        display: "block",
                        width: "100%",
                        boxSizing: "border-box",
                        marginTop: 6,
                        padding: "10px 12px",
                        border: "1px solid #c9cccf",
                        borderRadius: 8,
                        background: "#f6f6f7",
                        color: "#616161",
                      }}
                    />
                  </label>

                  <label
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: "#4a4a4a",
                    }}
                  >
                    Contact email
                    <input
                      name="email"
                      type="email"
                      required
                      placeholder="you@example.com"
                      style={{
                        display: "block",
                        width: "100%",
                        boxSizing: "border-box",
                        marginTop: 6,
                        padding: "10px 12px",
                        border: "1px solid #c9cccf",
                        borderRadius: 8,
                      }}
                    />
                  </label>
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "repeat(auto-fit, minmax(180px, 1fr))",
                    gap: 14,
                  }}
                >
                  <label
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: "#4a4a4a",
                    }}
                  >
                    Indexed products needed
                    <input
                      name="indexedProducts"
                      type="number"
                      min="0"
                      placeholder="e.g. 5000"
                      style={{
                        display: "block",
                        width: "100%",
                        boxSizing: "border-box",
                        marginTop: 6,
                        padding: "10px 12px",
                        border: "1px solid #c9cccf",
                        borderRadius: 8,
                      }}
                    />
                  </label>

                  <label
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: "#4a4a4a",
                    }}
                  >
                    AI searches / month
                    <input
                      name="monthlySearches"
                      type="number"
                      min="0"
                      placeholder="e.g. 50000"
                      style={{
                        display: "block",
                        width: "100%",
                        boxSizing: "border-box",
                        marginTop: 6,
                        padding: "10px 12px",
                        border: "1px solid #c9cccf",
                        borderRadius: 8,
                      }}
                    />
                  </label>

                  <label
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: "#4a4a4a",
                    }}
                  >
                    Vector updates / month
                    <input
                      name="vectorUpdates"
                      type="number"
                      min="0"
                      placeholder="e.g. 10000"
                      style={{
                        display: "block",
                        width: "100%",
                        boxSizing: "border-box",
                        marginTop: 6,
                        padding: "10px 12px",
                        border: "1px solid #c9cccf",
                        borderRadius: 8,
                      }}
                    />
                  </label>
                </div>

                <label
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: "#4a4a4a",
                  }}
                >
                  Requirements / message
                  <textarea
                    name="message"
                    rows={5}
                    required
                    placeholder="Tell us about your requirements, expected traffic, features, or anything you would like to discuss."
                    style={{
                      display: "block",
                      width: "100%",
                      boxSizing: "border-box",
                      marginTop: 6,
                      padding: "10px 12px",
                      border: "1px solid #c9cccf",
                      borderRadius: 8,
                      resize: "vertical",
                      fontFamily: "inherit",
                    }}
                  />
                </label>

                <div
                  style={{
                    display: "flex",
                    gap: 10,
                    justifyContent: "flex-end",
                    alignItems: "center",
                    marginTop: 4,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setCustomShowForm(false)}
                    style={{
                      padding: "10px 16px",
                      borderRadius: 8,
                      border: "1px solid #c9cccf",
                      background: "#fff",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    style={{
                      padding: "10px 18px",
                      borderRadius: 8,
                      border: "none",
                      background: "#008060",
                      color: "#fff",
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    Send Request
                  </button>
                </div>
              </form>
            )}
          </>
        ) : (
          <div style={{ maxWidth: 680, margin: "0 auto" }}>
            <div
              style={{
                padding: 18,
                borderRadius: 10,
                background: "#e4f8f0",
                border: "1px solid #b7e5d3",
                color: "#006644",
                marginBottom: 20,
              }}
            >
              <strong style={{ display: "block", marginBottom: 6 }}>
                Custom plan request sent
              </strong>
              Your request has been received. We will contact you to discuss
              the requirements and agree on the plan and price.
            </div>

            <div
              style={{
                border: "1px solid #e1e3e5",
                borderRadius: 12,
                padding: 20,
                background: "#fafafa",
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: "#8c9196",
                  textTransform: "uppercase",
                  marginBottom: 8,
                }}
              >
                Waiting for offer
              </div>
              <h3
                style={{
                  margin: "0 0 8px 0",
                  fontSize: 18,
                  color: "#1a1a1a",
                }}
              >
                Your custom plan will appear here
              </h3>
              <p
                style={{
                  margin: "0 0 16px 0",
                  fontSize: 13,
                  color: "#616161",
                  lineHeight: 1.6,
                }}
              >
                After we agree on the requirements and price, the app can show
                the agreed offer here together with a Shopify payment
                button.
              </p>

              <div
                style={{
                  padding: 14,
                  borderRadius: 8,
                  background: "#fff",
                  border: "1px dashed #c9cccf",
                  fontSize: 12,
                  color: "#8c9196",
                }}
              >
                <strong style={{ color: "#616161" }}>Next step:</strong> once
                an offer is agreed, the backend will provide the final price,
                billing interval, and Shopify payment link/button here.
              </div>
            </div>
          </div>
        )}
      </div>

      <div
        style={{
          maxWidth: 960,
          margin: "40px auto 0 auto",
          padding: 20,
          background: "#f9fafb",
          borderRadius: 12,
          border: "1px solid #e5e7eb",
          fontSize: 13,
          color: "#6b7280",
          lineHeight: 1.6,
        }}
      >
        <strong
          style={{ color: "#374151", display: "block", marginBottom: 6 }}
        >
          🔒 Secure Checkout via Shopify Billing API:
        </strong>
        All app charges are billed directly through your monthly Shopify
        Invoice. You can upgrade, downgrade, or cancel your subscription at
        any time within Shopify Admin without hidden fees.
      </div>
    </div>
  );
}
