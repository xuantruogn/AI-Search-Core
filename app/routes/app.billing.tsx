import { useState, useEffect } from "react";
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

import { PLAN_DEFINITIONS } from "../services/commerce/plans.server";
import { getShopEntitlement } from "../services/commerce/entitlement.server";
import { getSubscriptionSnapshot } from "../services/commerce/shop-registry.server";
import { reconcileShopCommercialState } from "../services/commerce/reconciliation.server";
import { setBillingPlanChangeState } from "../services/commerce/billing-state.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const debugId = crypto.randomUUID().slice(0, 8);
  console.log("[BILLING TRACE] loader:start", { debugId, method: request.method, url: request.url, referer: request.headers.get("referer"), remixRequest: request.headers.get("x-remix-request"), secFetchMode: request.headers.get("sec-fetch-mode") });
  const { session } = await authenticate.admin(request);
  console.log("[BILLING DEBUG] loader:authenticated", { debugId, shop: session.shop });

  const entitlement = await getShopEntitlement(session.shop);
  const subscription = await getSubscriptionSnapshot(session.shop, { ensure: false });
  const billingPlans = await db.plan.findMany({
    where: { handle: { in: ["basic", "pro"] } },
    select: { handle: true, trialDays: true },
  });

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
    plans: [PLAN_DEFINITIONS.BASIC, PLAN_DEFINITIONS.PRO].map((plan) => ({
      ...plan,
      trialDays:
        billingPlans.find((billingPlan) => billingPlan.handle === plan.key.toLowerCase())
          ?.trialDays ?? 0,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const debugId = crypto.randomUUID().slice(0, 8);
  console.log("[BILLING DEBUG] action:start", { debugId, method: request.method, url: request.url });
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  console.log("[BILLING DEBUG] action:authenticated", { debugId, shop: session.shop, intent });

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
      console.log("[BILLING DEBUG] cancel:start", { debugId, shop: session.shop });
      const snapshot = await getSubscriptionSnapshot(session.shop, { ensure: false });
      console.log("[BILLING DEBUG] cancel:snapshot", {
        debugId, shop: session.shop, plan: snapshot.plan, planHandle: snapshot.planHandle,
        status: snapshot.status, cancellationStatus: snapshot.cancellationStatus,
        accessStatus: snapshot.accessStatus, commercialStatus: snapshot.commercialStatus,
        subscriptionGid: snapshot.shopifySubscriptionId,
        billingPeriodEnd: snapshot.billingPeriodEnd?.toISOString() ?? null,
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
          message: "This subscription is already set not to renew for the next cycle.",
        };
      }

      if (snapshot.status !== "ACTIVE") {
        return {
          success: false,
          message: `This subscription cannot be set to stop renewal from its current status: ${snapshot.status}.`,
        };
      }

      // Shopify Admin Billing API: prorate=false stops the next billing cycle
      // while preserving the merchant's already-paid current period.
      console.log("[BILLING DEBUG] cancel:shopify:start", { debugId, shop: session.shop, subscriptionGid });
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
          message: message || "Shopify could not stop the next subscription renewal.",
        };
      }

      const cancelled = payload.data?.appSubscriptionCancel?.appSubscription;
      console.log("[BILLING DEBUG] cancel:shopify:response", {
        debugId, shop: session.shop, subscriptionGid,
        cancelledId: cancelled?.id ?? null, cancelledStatus: cancelled?.status ?? null,
        graphqlErrors: graphQLErrors.length, userErrors: userErrors.length,
      });

      if (!cancelled?.id) {
        return {
          success: false,
          message: "Shopify did not return the cancelled subscription.",
        };
      }

      console.log("[BILLING DEBUG] cancel:reconcile:start", {
        debugId, shop: session.shop, expectedSubscriptionGid: cancelled.id,
      });
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
        debugId, shop: session.shop,
        plan: reconciliation.subscription.plan, status: reconciliation.subscription.status,
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
    const planKey = String(form.get("planKey") || "");
    const cycle = String(form.get("cycle") || "monthly");

    const requestedReplacementBehavior =
      String(form.get("replacementBehavior") || "APPLY_IMMEDIATELY");
    const replacementBehavior =
      requestedReplacementBehavior === "APPLY_ON_NEXT_BILLING_CYCLE"
        ? "APPLY_ON_NEXT_BILLING_CYCLE"
        : requestedReplacementBehavior === "STANDARD"
          ? "STANDARD"
          : "APPLY_IMMEDIATELY";

    const baseMonthlyPrice = planKey === "PRO" ? 29.9 : 9.9;
    const billingPlan = await db.plan.findUnique({
      where: { handle: planKey.toLowerCase() },
      select: { trialDays: true },
    });

    // Trial is a shop-level first-subscription benefit, not a per-plan-change
    // benefit. Once this shop has ever had a Billing V2 subscription, every
    // later replacement/change must be created without trialDays.
    //
    // AiSearchSubscription is bootstrapped for every shop even when there has
    // never been a paid/trial subscription, so its mere existence is not
    // sufficient to determine trial eligibility. A real BillingSubscription
    // row is the authoritative local marker that billing history has started.
    const hasBillingHistory = Boolean(
      await db.billingSubscription.findFirst({
        where: { shop: session.shop },
        select: { id: true },
      }),
    );

    const trialDays = hasBillingHistory
      ? 0
      : Math.max(0, billingPlan?.trialDays ?? 0);
    const isProduction = process.env.NODE_ENV === "production";

    let finalPrice = baseMonthlyPrice;
    let billingInterval = "EVERY_30_DAYS";
    let planName = `AI Search ${planKey} Plan (${cycle})`;

    if (cycle === "yearly") {
      finalPrice = baseMonthlyPrice * 0.8 * 12;
      billingInterval = "ANNUAL";
    }

    try {
      const shopHandle = session.shop.replace(/\.myshopify\.com$/i, "");
      const appIdentifier =
        process.env.SHOPIFY_APP_HANDLE?.trim() ||
        process.env.SHOPIFY_API_KEY?.trim();

      if (!appIdentifier) {
        throw new Error("Shopify app identifier is not configured.");
      }

      const returnUrl = new URL(
        `https://admin.shopify.com/store/${encodeURIComponent(shopHandle)}/apps/${encodeURIComponent(appIdentifier)}/app/billing`,
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
                  price: { amount: $price, currencyCode: USD }
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
            test: !isProduction,
            trialDays: trialDays > 0 ? trialDays : null,
            interval: billingInterval,
            replacementBehavior,
          },
        }
      );

      const responseJson = await response.json();
      const subscriptionData = responseJson.data?.appSubscriptionCreate;

      if (subscriptionData?.userErrors && subscriptionData.userErrors.length > 0) {
        const errorMsg = subscriptionData.userErrors.map((e: any) => e.message).join(", ");
        return {
          success: false,
          message: errorMsg.includes("public distribution")
            ? "Shopify Billing is unavailable for the currently linked app because it does not have Public distribution enabled. Link/run a Public-distribution app configuration, then retry."
            : `Shopify Error: ${errorMsg}`,
        };
      }

      const createdSubscription = subscriptionData?.appSubscription;
      if (!createdSubscription?.id) {
        return { success: false, message: "Shopify did not return subscription ID." };
      }

      await db.aiSearchShop.update({
        where: { shop: session.shop },
        data: {
          pendingPlanHandle: planKey.toLowerCase(),
          pendingSubscriptionGid: createdSubscription.id,
        },
      });

      await reconcileShopifySubscriptionFromAdmin({
        shop: session.shop,
        admin,
        expectedSubscriptionGid: createdSubscription.id,
        preferredPlanHandle: planKey.toLowerCase(),
        authoritativePlanHandle: planKey.toLowerCase(),
        source: "CALLBACK",
      });

      if (replacementBehavior === "APPLY_ON_NEXT_BILLING_CYCLE") {
        await setBillingPlanChangeState({
          shop: session.shop,
          subscriptionGid: createdSubscription.id,
          status: "DEFERRED",
          source: "CALLBACK",
          reason: "APP_SUBSCRIPTION_REPLACEMENT_BEHAVIOR_APPLY_ON_NEXT_BILLING_CYCLE",
        });
      }

      const confirmationUrl = subscriptionData?.confirmationUrl;
      if (confirmationUrl) {
        return { success: true, confirmationUrl };
      }

      return { success: false, message: "Failed to create payment link." };
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  return { success: false, message: "Invalid action intent" };
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



  const cycleDiscount = {
    monthly: 0,
    yearly: 0.2,
  };

  const cycleText = {
    monthly: "/month",
    yearly: "/month (billed annually)",
  };

  const currentPlanKey = data.entitlement.planLabel?.toUpperCase() || "NONE";
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

  const planConfigs = {
    BASIC: {
      badge: "Popular",
      badgeBg: "#008060",
      priceBase: 9.9,
      originalPrice: "$14.99/month",
      isPopular: false,
      btnBg: "#008060",
      features: [
        limitText(
          data.plans[0]?.limits.productLimit ?? 500,
          "Indexed products",
        ),
        limitText(
          data.plans[0]?.limits.searchLimit ?? 3000,
          "Searches / period",
        ),
        limitText(
          data.plans[0]?.limits.vectorUpdateLimit ?? 500,
          "vector updates / period",
        ),
        "Auto-fallback to Shopify Search when quota exceeded",
        "24/7 Email & Ticket Support",
      ],
      buildWith: ["Search Engine", "Keyword Suggestions"],
    },
    PRO: {
      badge: "Save 40%",
      badgeBg: "#e51c00",
      priceBase: 29.9,
      originalPrice: "$49.99/month",
      isPopular: true,
      btnBg: "#e51c00",
      features: [
        limitText(
          data.plans[1]?.limits.productLimit ?? null,
          "Indexed products",
        ),
        limitText(
          data.plans[1]?.limits.searchLimit ?? null,
          "Searches / period",
        ),
        limitText(
          data.plans[1]?.limits.vectorUpdateLimit ?? null,
          "vector updates / period",
        ),
        "Priority Vector Search bandwidth processing",
        "Auto-optimized Synonyms & Search Intent",
        "1-on-1 Dedicated Technical Support",
      ],
      buildWith: ["Vector Analytics", "Full Synonyms Map"],
    },
  };

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
            Basic and Pro include a free trial. All paid plan changes are confirmed through Shopify.
          </p>

          <div
            style={{
              display: "inline-flex",
              background: "#f4f4f5",
              padding: 4,
              borderRadius: 999,
              gap: 4,
            }}
          >
            <button
              type="button"
              onClick={() => setCycle("monthly")}
              style={{
                padding: "8px 18px",
                borderRadius: 999,
                border: "none",
                background: cycle === "monthly" ? "#fff" : "transparent",
                fontWeight: 700,
                fontSize: 13,
                color: cycle === "monthly" ? "#111827" : "#6b7280",
                cursor: "pointer",
                boxShadow: cycle === "monthly" ? "0 1px 4px rgba(0,0,0,.08)" : "none",
              }}
            >
              Monthly
            </button>
            <button
              type="button"
              onClick={() => setCycle("yearly")}
              style={{
                padding: "8px 18px",
                borderRadius: 999,
                border: "none",
                background: cycle === "yearly" ? "#fff" : "transparent",
                fontWeight: 700,
                fontSize: 13,
                color: cycle === "yearly" ? "#111827" : "#6b7280",
                cursor: "pointer",
                boxShadow: cycle === "yearly" ? "0 1px 4px rgba(0,0,0,.08)" : "none",
              }}
            >
              Yearly <span style={{ color: "#5b3df5" }}>Save 20%</span>
            </button>
          </div>
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
          {data.plans.map((plan) => {
            const isPro = plan.key === "PRO";
            const config = isPro ? planConfigs.PRO : planConfigs.BASIC;
            const discountedPrice = (
              config.priceBase * (1 - cycleDiscount[cycle])
            ).toFixed(2);
            const billedAmount =
              cycle === "yearly"
                ? (config.priceBase * 0.8 * 12).toFixed(2)
                : config.priceBase.toFixed(2);
            const isCurrentPlan = isActive && currentPlanKey.includes(plan.key);

            return (
              <article
                key={plan.key}
                style={{
                  position: "relative",
                  background: "#fff",
                  borderRadius: 14,
                  border: isPro ? "2px solid #5b3df5" : "1px solid #dfe3ea",
                  padding: "28px 28px 26px",
                  boxSizing: "border-box",
                  minHeight: 405,
                  display: "flex",
                  flexDirection: "column",
                  boxShadow: isPro
                    ? "0 14px 34px rgba(91,61,245,.10)"
                  : "0 2px 8px rgba(17,24,39,.03)",
                }}
              >
                {isPro ? (
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
                  {plan.label}
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
                  {plan.description}
                </p>

                <div style={{ marginBottom: 18 }}>
                  <span style={{ fontSize: 34, fontWeight: 800, color: "#111827" }}>
                    ${discountedPrice}
                  </span>
                  <span style={{ marginLeft: 6, color: "#667085", fontSize: 13 }}>
                    / month
                  </span>
                  <div style={{ color: "#667085", fontSize: 12, marginTop: 6 }}>
                    {cycle === "yearly"
                      ? `Billed $${billedAmount} annually`
                      : `Billed $${billedAmount} monthly`}
                  </div>
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
                  {config.features.slice(0, 4).map((feat) => (
                    <li key={feat} style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
                      <span style={{ color: "#12a66a", fontWeight: 800 }}>✓</span>
                      <span>{feat}</span>
                    </li>
                  ))}
                </ul>

                <subscribeFetcher.Form method="post" style={{ marginTop: "auto" }}>
                  <input type="hidden" name="intent" value="subscribe" />
                  <input type="hidden" name="planKey" value={plan.key} />
                  <input type="hidden" name="cycle" value={cycle} />
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
                        : isPro
                        ? "#5b3df5"
                        : "#fff",
                      color: isCurrentPlan ? "#737b88" : isPro ? "#fff" : "#5b3df5",
                      fontWeight: 800,
                      cursor: isCurrentPlan ? "not-allowed" : "pointer",
                    }}
                  >
                    {isCurrentPlan
                      ? "Current plan"
                      : subscribeFetcher.state !== "idle"
                        ? "Redirecting..."
                        : `Start with ${plan.label}`}
                  </button>
                </subscribeFetcher.Form>
              </article>
            );
          })}

          <article
            style={{
              background: "#fff",
              borderRadius: 14,
              border: "1px solid #dfe3ea",
              padding: "28px 28px 26px",
              boxSizing: "border-box",
              minHeight: 405,
              display: "flex",
              flexDirection: "column",
              boxShadow: "0 2px 8px rgba(17,24,39,.03)",
            }}
          >
            <h2 style={{ margin: "0 0 10px", fontSize: 20, color: "#111827" }}>Custom</h2>
            <p
              style={{
                margin: "0 0 26px",
                color: "#667085",
                fontSize: 13,
                lineHeight: 1.55,
                minHeight: 40,
              }}
            >
              Limits and pricing tailored to your store requirements.
            </p>

            <div style={{ marginBottom: 22 }}>
              <span style={{ fontSize: 32, fontWeight: 800, color: "#111827" }}>Contact us</span>
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
              {[
                "Custom product and search limits",
                "Usage and cost tracking",
                "Managed through Shopify Billing",
                "Dedicated implementation support",
              ].map((feat) => (
                <li key={feat} style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
                  <span style={{ color: "#12a66a", fontWeight: 800 }}>✓</span>
                  <span>{feat}</span>
                </li>
              ))}
            </ul>

            <button
              type="button"
              onClick={() => setCustomShowForm((value) => !value)}
              style={{
                marginTop: "auto",
                width: "100%",
                padding: "11px 16px",
                borderRadius: 9,
                border: "1px solid #5b3df5",
                background: "#fff",
                color: "#5b3df5",
                fontWeight: 800,
                cursor: "pointer",
              }}
            >
              {customShowForm ? "Hide request form" : "Start with Custom"}
            </button>
          </article>
        </div>

        {customShowForm ? (
          <div
            style={{
              marginTop: 20,
              padding: 24,
              border: "1px solid #dfe3ea",
              borderRadius: 14,
              background: "#fff",
            }}
          >
            {!customRequestSent ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  setCustomRequestSent(true);
                }}
                style={{
                  display: "grid",
                  gap: 14,
                }}
              >
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                    gap: 14,
                  }}
                >
                  <label style={{ fontSize: 12, fontWeight: 700, color: "#475467" }}>
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
                        border: "1px solid #d0d5dd",
                        borderRadius: 8,
                        background: "#f8fafc",
                      }}
                    />
                  </label>
                  <label style={{ fontSize: 12, fontWeight: 700, color: "#475467" }}>
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
                        border: "1px solid #d0d5dd",
                        borderRadius: 8,
                      }}
                    />
                  </label>
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                    gap: 14,
                  }}
                >
                  {[
                    ["indexedProducts", "Indexed products needed", "5000"],
                    ["monthlySearches", "Searches / month", "50000"],
                    ["vectorUpdates", "Vector updates / month", "10000"],
                  ].map(([name, label, placeholder]) => (
                    <label key={name} style={{ fontSize: 12, fontWeight: 700, color: "#475467" }}>
                      {label}
                      <input
                        name={name}
                        type="number"
                        min="0"
                        placeholder={placeholder}
                        style={{
                          display: "block",
                          width: "100%",
                          boxSizing: "border-box",
                          marginTop: 6,
                          padding: "10px 12px",
                          border: "1px solid #d0d5dd",
                          borderRadius: 8,
                        }}
                      />
                    </label>
                  ))}
                </div>

                <label style={{ fontSize: 12, fontWeight: 700, color: "#475467" }}>
                  Requirements / message
                  <textarea
                    name="message"
                    rows={4}
                    required
                    placeholder="Tell us about your requirements, expected traffic, or special needs."
                    style={{
                      display: "block",
                      width: "100%",
                      boxSizing: "border-box",
                      marginTop: 6,
                      padding: "10px 12px",
                      border: "1px solid #d0d5dd",
                      borderRadius: 8,
                      resize: "vertical",
                      fontFamily: "inherit",
                    }}
                  />
                </label>

                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button
                    type="submit"
                    style={{
                      padding: "10px 18px",
                      borderRadius: 8,
                      border: "none",
                      background: "#5b3df5",
                      color: "#fff",
                      fontWeight: 800,
                      cursor: "pointer",
                    }}
                  >
                    Send request
                  </button>
                </div>
              </form>
            ) : (
              <div
                style={{
                  padding: 16,
                  borderRadius: 10,
                  background: "#ecfdf3",
                  border: "1px solid #abefc6",
                  color: "#067647",
                }}
              >
                <strong style={{ display: "block", marginBottom: 5 }}>Custom plan request sent</strong>
                Your request has been received. We will contact you to discuss the requirements and pricing.
              </div>
            )}
          </div>
        ) : null}
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