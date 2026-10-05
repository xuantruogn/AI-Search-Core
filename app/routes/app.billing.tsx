import { useEffect } from "react";
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
import {
  getShopCustomPlanAssignment,
  parsePlanFeatureFlags,
  PLAN_CAPABILITY_DEFINITIONS,
  resolveShopCustomPlanTerms,
} from "../services/commerce/plan-catalog.server";

const BILLING_CAPABILITIES = [
  ["semanticSearch", "Semantic search"],
  ["multilingualSearch", "Multilingual query translation"],
  ["searchAnalytics", "Search analytics"],
  ["themeIntegration", "Theme Map integration"],
  ["selfRendering", "Self-rendering storefront mode"],
  ["customDataMode", "Custom data mode"],
] as const;

function planPresentation(value: unknown) {
  const features = parsePlanFeatureFlags(value);
  const capabilityLabels = PLAN_CAPABILITY_DEFINITIONS
    .filter(({ key }) => features.capabilities[key])
    .map(({ label }) => label);
  return {
    description: features.description,
    highlights: features.highlights,
    capabilityLabels,
    capabilities: features.capabilities,
    merchantFeatures: features.merchantFeatures,
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const debugId = crypto.randomUUID().slice(0, 8);
  console.log("[BILLING TRACE] loader:start", { debugId, method: request.method, url: request.url, referer: request.headers.get("referer"), remixRequest: request.headers.get("x-remix-request"), secFetchMode: request.headers.get("sec-fetch-mode") });
  const { session } = await authenticate.admin(request);
  console.log("[BILLING DEBUG] loader:authenticated", { debugId, shop: session.shop });

  const entitlement = await getShopEntitlement(session.shop);
  const subscription = await getSubscriptionSnapshot(session.shop, { ensure: false });

  const hasEverApprovedSubscription = Boolean(
    await db.billingEvent.findFirst({
      where: {
        shop: session.shop,
        type: "SUBSCRIPTION_APPROVED",
      },
      select: { id: true },
    }),
  );
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
  const customAssignment = await getShopCustomPlanAssignment(session.shop);
  const customTerms = resolveShopCustomPlanTerms(customAssignment);

  let daysRemaining: number | null = null;
  let formattedPeriodEnd: string | null = null;

  if (subscription.billingPeriodEnd) {
    const endDate = new Date(subscription.billingPeriodEnd);
    const now = new Date();
    const diffTime = endDate.getTime() - now.getTime();
    daysRemaining = Math.max(0, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
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
      billingPeriodStart: subscription.billingPeriodStart?.toISOString() ?? null,
      billingPeriodEnd: subscription.billingPeriodEnd?.toISOString() ?? null,
      lastSyncedAt: subscription.lastSyncedAt?.toISOString() ?? null,
      daysRemaining,
      formattedPeriodEnd,
    },
    pricingUrl: getShopifyPricingPlansUrl(session.shop),
    partnerApiConfigured: isShopifyAppPricingConfigured(),
    plans: billingPlans.map((plan) => {
      const presentation = planPresentation(plan.featureFlags);
      return {
        id: plan.id,
        handle: plan.handle,
        name: plan.name,
        price: Number(plan.price),
        currencyCode: plan.currencyCode,
        interval: plan.interval,
        trialDays:
          plan.handle.toLowerCase() === "basic" &&
          (hasEverApprovedSubscription === false ||
            (subscription.plan === "BASIC" &&
              subscription.trialStatus === "ACTIVE"))
            ? plan.trialDays
            : 0,
        description: presentation.description,
        highlights: presentation.highlights,
        capabilityLabels: presentation.capabilityLabels,
        capabilities: presentation.capabilities,
        merchantFeatures: presentation.merchantFeatures,
        limits: {
          productLimit: plan.maxIndexedProducts,
          searchLimit: plan.maxMonthlySearches,
          vectorUpdateLimit: plan.maxMonthlyVectorUpdates,
        },
      };
    }),
    customPlan:
      customTerms && customTerms.price !== null
        ? {
            id: customTerms.planId,
            handle: customTerms.handle,
            name: customTerms.name,
            price: customTerms.price,
            currencyCode: customTerms.currencyCode,
            interval: customTerms.interval,
            trialDays: customTerms.trialDays,
            description: customTerms.features.description,
            highlights: customTerms.features.highlights,
            capabilityLabels: PLAN_CAPABILITY_DEFINITIONS
              .filter(
                ({ key }) =>
                  customTerms.features.capabilities[key],
              )
              .map(({ label }) => label),
            capabilities: customTerms.features.capabilities,
            merchantFeatures: customTerms.features.merchantFeatures,
            limits: customTerms.limits,
            usageBillingEnabled:
              customTerms.usageBillingEnabled,
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
        ? await getShopCustomPlanAssignment(session.shop)
        : null;
    const customTerms =
      planHandle === "custom"
        ? resolveShopCustomPlanTerms(customAssignment)
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
      (planHandle === "custom" &&
        (!customTerms || customTerms.price === null))
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

    const finalPrice = customTerms?.price ?? Number(billingPlan.price);
    const billingInterval = customTerms?.interval ?? billingPlan.interval;
    const currencyCode = customTerms?.currencyCode ?? billingPlan.currencyCode;
    const planName = `AI Search ${customTerms?.name ?? billingPlan.name} Plan`;

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
          message: errorMsg.includes("public distribution")
            ? "Shopify Billing is unavailable for the currently linked app because it does not have Public distribution enabled. Link/run a Public-distribution app configuration, then retry."
            : errorMsg
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

  useEffect(() => {
    if (subscribeFetcher.data?.confirmationUrl) {
      console.log(`[BILLING CLIENT REDIRECT] Redirecting top location to confirmationUrl`);
      window.top!.location.href = subscribeFetcher.data.confirmationUrl;
    }
  }, [subscribeFetcher.data]);

  useEffect(() => {
    if (window.location.hash !== "#plans") return;
    window.requestAnimationFrame(() => {
      document.getElementById("plans")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  }, []);



  const currentPlanHandle = data.subscription.planHandle?.toLowerCase() ?? null;
  const availablePlans = data.customPlan
    ? [...data.plans, data.customPlan]
    : data.plans;
  const comparisonFeatureCatalog = Array.from(
    new Map(
      availablePlans
        .flatMap((plan) => plan.merchantFeatures ?? [])
        .map((feature) => [feature.key, { key: feature.key, label: feature.label }]),
    ).values(),
  );
  const subscribeError =
    subscribeFetcher.data &&
    "success" in subscribeFetcher.data &&
    subscribeFetcher.data.success === false &&
    "message" in subscribeFetcher.data
      ? String(subscribeFetcher.data.message)
      : null;
  const isNonRenewing = data.entitlement.cancellationStatus === "NON_RENEWING";
  const isActive =
    data.entitlement.subscriptionStatus === "ACTIVE" || isNonRenewing;

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
      {/* SECTION 1: ACCOUNT OVERVIEW & SUBSCRIPTION STATUS */}
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
            style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "#1a1a1a" }}
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
              {fetcher.state !== "idle"
                ? "Syncing..."
                : "Sync Billing Status"}
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
              border: `1px solid ${isNonRenewing ? "#f0d98a" : "#cfe9df"}`,
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
                    cursor: cancelFetcher.state === "idle" && !isNonRenewing ? "pointer" : "default",
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
                    <span style={{ display: "block", color: "#6b6b6b", marginTop: 2 }}>
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
                    cursor: cancelFetcher.state === "idle" && !isNonRenewing ? "pointer" : "default",
                  }}
                >
                  <input
                    type="radio"
                    name="renewalChoice"
                    value="stop"
                    checked={isNonRenewing}
                    disabled={isNonRenewing}
                    onChange={(event) => {
                      if (!event.target.checked || cancelFetcher.state !== "idle") return;

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
                    <span style={{ display: "block", color: "#6b6b6b", marginTop: 2 }}>
                      Keep the current plan active until the end of this billing period.
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
          <p style={{ margin: "10px 0 0 0", fontSize: 12, color: "#008060" }}>
            {fetcher.data.message}
          </p>
        ) : null}
      </div>

      {/* SECTION 2: CURRENT USAGE & QUOTA METRICS */}
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
        <h3 style={{ margin: "0 0 14px 0", fontSize: 15, fontWeight: 700, color: "#1a1a1a" }}>
          📊 Usage & Capacity this Period
        </h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
          {/* Searches */}
          <div style={{ border: "1px solid #f1f2f3", borderRadius: 8, padding: 14, background: "#fafafa" }}>
            <div style={{ fontSize: 12, color: "#616161", marginBottom: 4 }}>Searches</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#1a1a1a" }}>
              {data.entitlement.usage.searchCount.toLocaleString("en-US")} / {limitText(data.entitlement.limits.searchLimit, "")}
            </div>
            <div style={{ fontSize: 11, color: "#008060", marginTop: 4 }}>
              Auto-fallbacks to Shopify Search when limit reached
            </div>
          </div>

          {/* Indexed Products */}
          <div style={{ border: "1px solid #f1f2f3", borderRadius: 8, padding: 14, background: "#fafafa" }}>
            <div style={{ fontSize: 12, color: "#616161", marginBottom: 4 }}>Indexed Products</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#1a1a1a" }}>
              {data.entitlement.indexedProducts.toLocaleString("en-US")} / {limitText(data.entitlement.limits.productLimit, "")}
            </div>
            <div style={{ fontSize: 11, color: "#616161", marginTop: 4 }}>
              Products ready for ranking
            </div>
          </div>

          {/* Vector Updates */}
          <div style={{ border: "1px solid #f1f2f3", borderRadius: 8, padding: 14, background: "#fafafa" }}>
            <div style={{ fontSize: 12, color: "#616161", marginBottom: 4 }}>Vector Updates</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#1a1a1a" }}>
              {data.entitlement.usage.vectorUpdateCount.toLocaleString("en-US")} / {limitText(data.entitlement.limits.vectorUpdateLimit, "")}
            </div>
            <div style={{ fontSize: 11, color: "#616161", marginTop: 4 }}>
              Vector data update executions
            </div>
          </div>
        </div>
      </div>

      {/* SECTION 3: PLAN SELECTION */}
      <section
        id="plans"
        style={{
          scrollMarginTop: 24,
          maxWidth: 1180,
          margin: "0 auto",
          padding: "8px 0 0",
        }}
      >
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div
            style={{
              color: "#5b3df5",
              fontSize: 12,
              fontWeight: 800,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              marginBottom: 10,
            }}
          >
            Billing through Shopify
          </div>
          <h1
            style={{
              fontSize: 30,
              lineHeight: 1.15,
              fontWeight: 800,
              color: "#111827",
              margin: "0 0 10px",
            }}
          >
            Plans that scale with your store
          </h1>
          <p style={{ color: "#667085", fontSize: 14, margin: "0 0 18px" }}>
            Available plans, pricing, quotas and trial terms are managed by AI-Buyense. All paid plan changes are confirmed through Shopify.
          </p>
        </div>

        {subscribeError ? (
          <div
            role="alert"
            style={{
              margin: "0 0 18px",
              padding: "12px 14px",
              borderRadius: 10,
              border: "1px solid #f0a08c",
              background: "#fff6f3",
              color: "#9a3412",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            {subscribeError}
          </div>
        ) : null}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(270px, 1fr))",
            gap: 18,
            alignItems: "stretch",
          }}
        >
          {availablePlans.map((plan) => {
            const isFeatured = plan.handle.toLowerCase() === "pro";
            const isCurrentPlan =
              isActive && currentPlanHandle === plan.handle.toLowerCase();
            const planMerchantFeatures = new Map(
              (plan.merchantFeatures ?? []).map((feature) => [feature.key, feature]),
            );
            const featureList = [
              {
                key: "limit-products",
                label: limitText(plan.limits.productLimit, "Indexed products"),
                included: true,
              },
              {
                key: "limit-searches",
                label: limitText(plan.limits.searchLimit, "Searches / period"),
                included: true,
              },
              {
                key: "limit-vectors",
                label: limitText(plan.limits.vectorUpdateLimit, "Vector updates / period"),
                included: true,
              },
              ...BILLING_CAPABILITIES.map(([key, label]) => ({
                key: `capability-${key}`,
                label,
                included: plan.capabilities[key],
              })),
              ...comparisonFeatureCatalog.map((feature) => ({
                key: `merchant-${feature.key}`,
                label: feature.label,
                included: planMerchantFeatures.get(feature.key)?.included === true,
              })),
              ...plan.highlights.map((label, index) => ({
                key: `highlight-${index}-${label}`,
                label,
                included: true,
              })),
            ];
            const formattedPrice = new Intl.NumberFormat(undefined, {
              style: "currency",
              currency: plan.currencyCode,
              maximumFractionDigits: 2,
            }).format(plan.price);

            return (
              <article
                key={plan.id}
                style={{
                  position: "relative",
                  background: "#fff",
                  borderRadius: 14,
                  border: isFeatured ? "2px solid #5b3df5" : "1px solid #dfe3ea",
                  padding: "28px 28px 26px",
                  boxSizing: "border-box",
                  minHeight: 405,
                  display: "flex",
                  flexDirection: "column",
                  boxShadow: isFeatured
                    ? "0 14px 34px rgba(91,61,245,.10)"
                  : "0 2px 8px rgba(17,24,39,.03)",
                }}
              >
                {isFeatured ? (
                  <span
                    style={{
                      position: "absolute",
                      top: -12,
                      right: 18,
                      borderRadius: 999,
                      background: "#5b3df5",
                      color: "#fff",
                      padding: "5px 11px",
                      fontSize: 11,
                      fontWeight: 800,
                    }}
                  >
                    Popular
                  </span>
                ) : null}

                <h2 style={{ margin: "0 0 10px", fontSize: 20, color: "#111827" }}>
                  {plan.name}
                </h2>
                <p
                  style={{
                    margin: "0 0 26px",
                    color: "#667085",
                    fontSize: 13,
                    lineHeight: 1.55,
                    minHeight: 40,
                  }}
                >
                  {plan.description || "AI Search capacity configured for this plan."}
                </p>

                <div style={{ marginBottom: 18 }}>
                  <span style={{ fontSize: 34, fontWeight: 800, color: "#111827" }}>
                    {formattedPrice}
                  </span>
                  <span style={{ marginLeft: 6, color: "#667085", fontSize: 13 }}>
                    {plan.interval === "ANNUAL" ? "/ year" : "/ month"}
                  </span>
                  {plan.trialDays > 0 ? (
                    <div style={{ color: "#5b3df5", fontSize: 12, fontWeight: 700, marginTop: 5 }}>
                      {plan.trialDays}-day free trial
                    </div>
                  ) : null}
                </div>

                <ul
                  style={{
                    listStyle: "none",
                    padding: 0,
                    margin: "0 0 24px",
                    display: "grid",
                    gap: 10,
                    color: "#475467",
                    fontSize: 13,
                  }}
                >
                  {featureList.map((feature) => (
                    <li
                      key={feature.key}
                      style={{
                        display: "flex",
                        gap: 9,
                        alignItems: "flex-start",
                        color: feature.included ? "#475467" : "#98a2b3",
                      }}
                    >
                      <span
                        style={{
                          color: feature.included ? "#12a66a" : "#d92d20",
                          fontWeight: 800,
                          minWidth: 12,
                        }}
                      >
                        {feature.included ? "✓" : "×"}
                      </span>
                      <span>{feature.label}</span>
                    </li>
                  ))}
                </ul>

                <subscribeFetcher.Form method="post" style={{ marginTop: "auto" }}>
                  <input type="hidden" name="intent" value="subscribe" />
                  <input type="hidden" name="planHandle" value={plan.handle} />
                  <button
                    type="submit"
                    disabled={isCurrentPlan || subscribeFetcher.state !== "idle"}
                    style={{
                      width: "100%",
                      padding: "11px 16px",
                      borderRadius: 9,
                      border: "1px solid #5b3df5",
                      background: isCurrentPlan
                        ? "#eef0f3"
                        : isFeatured
                        ? "#5b3df5"
                        : "#fff",
                      color: isCurrentPlan ? "#737b88" : isFeatured ? "#fff" : "#5b3df5",
                      fontWeight: 800,
                      cursor: isCurrentPlan ? "not-allowed" : "pointer",
                    }}
                  >
                    {isCurrentPlan
                      ? "Current plan"
                      : subscribeFetcher.state !== "idle"
                        ? "Redirecting..."
                        : `Start with ${plan.name}`}
                  </button>
                </subscribeFetcher.Form>
              </article>
            );
          })}

        </div>

      </section>

      {/* SECTION 6: SHOPIFY BILLING DISCLAIMER */}
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
        <strong style={{ color: "#374151", display: "block", marginBottom: 6 }}>
          🔒 Secure Checkout via Shopify Billing API:
        </strong>
        All app charges are billed directly through your monthly Shopify Invoice. You can upgrade, downgrade, or cancel your subscription at any time within Shopify Admin without hidden fees.
      </div>
    </div>
  );
}