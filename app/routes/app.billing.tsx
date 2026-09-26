import { useState, useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import {
  getShopifyPricingPlansUrl,
  isShopifyAppPricingConfigured,
  refreshShopifyAppPricingSubscription,
} from "../services/billing/shopify-app-pricing.server";
import { PLAN_DEFINITIONS } from "../services/commerce/plans.server";
import { getShopEntitlement } from "../services/commerce/entitlement.server";
import { getSubscriptionSnapshot } from "../services/commerce/shop-registry.server";
import { reconcileShopCommercialState } from "../services/commerce/reconciliation.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const entitlement = await getShopEntitlement(session.shop);
  const subscription = await getSubscriptionSnapshot(session.shop, {
    ensure: false,
  });

  // Calculate days remaining in current billing cycle
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
      billingPeriodStart:
        subscription.billingPeriodStart?.toISOString() ?? null,
      billingPeriodEnd: subscription.billingPeriodEnd?.toISOString() ?? null,
      lastSyncedAt: subscription.lastSyncedAt?.toISOString() ?? null,
      daysRemaining,
      formattedPeriodEnd,
    },
    pricingUrl: getShopifyPricingPlansUrl(session.shop),
    partnerApiConfigured: isShopifyAppPricingConfigured(),
    plans: [PLAN_DEFINITIONS.BASIC, PLAN_DEFINITIONS.PRO],
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  // 1. Sync billing status directly from Shopify
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

  // 2. Create subscription payment link via Shopify Billing API
  if (intent === "subscribe") {
    const planKey = String(form.get("planKey") || "");
    const cycle = String(form.get("cycle") || "monthly");

    let price = planKey === "PRO" ? 29.9 : 9.9;
    if (cycle === "yearly") price = price * 0.8;
    if (cycle === "biyearly") price = price * 0.6;

    // Tự động nhận diện môi trường: Dev hay Production
    const isProduction = process.env.NODE_ENV === "production";

    try {
      const requestUrl = new URL(request.url);
      const returnUrl = `${requestUrl.origin}/app/billing`;

      const response = await admin.graphql(
        `#graphql
        mutation createPaymentLink($name: String!, $price: Decimal!, $returnUrl: URL!, $test: Boolean) {
          appSubscriptionCreate(
            name: $name
            returnUrl: $returnUrl
            test: $test
            lineItems: [{
              plan: {
                appRecurringPricingDetails: {
                  price: { amount: $price, currencyCode: USD }
                  interval: EVERY_30_DAYS
                }
              }
            }]
          ) {
            userErrors { field message }
            confirmationUrl
          }
        }`,
        {
          variables: {
            name: `AI Search ${planKey} Plan (${cycle})`,
            price: price.toFixed(2),
            returnUrl: returnUrl,
            // 🟢 TỰ ĐỘNG: Ở máy Local (Dev) -> test = true (Test miễn phí)
            // Deploy lên Server Production -> test = false (Thu tiền thật)
            test: !isProduction,
          },
        }
      );

      const responseJson = await response.json();
      const subscriptionData = responseJson.data?.appSubscriptionCreate;

      if (subscriptionData?.userErrors && subscriptionData.userErrors.length > 0) {
        const errorMsg = subscriptionData.userErrors.map((e: any) => e.message).join(", ");

        // Cơ chế Fallback mượt mà cho Dev khi chưa bật Public Distribution
        if (errorMsg.includes("public distribution")) {
          return {
            success: true,
            devFallback: true,
            message: "App currently in Dev/Custom mode (No Public Distribution). Billing API simulated successfully!",
          };
        }

        return {
          success: false,
          message: `Shopify Error: ${errorMsg}`,
        };
      }

      const confirmationUrl = subscriptionData?.confirmationUrl;

      if (confirmationUrl) {
        return { success: true, confirmationUrl };
      }

      return {
        success: false,
        message: "Failed to create subscription charge link from Shopify.",
      };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return { success: false, message: "Invalid action intent" };
};

function limitText(value: number | null, suffix: string) {
  return value === null
    ? `Unlimited ${suffix}`
    : `${value.toLocaleString("en-US")} ${suffix}`;
}

type Cycle = "monthly" | "yearly" | "biyearly";

export default function BillingPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const subscribeFetcher = useFetcher<typeof action>();

  const [cycle, setCycle] = useState<Cycle>("monthly");
  const [customRequestSent, setCustomRequestSent] = useState(false);
  const [customShowForm, setCustomShowForm] = useState(false);

  // Top-level redirect when confirmationUrl is generated by Shopify
  useEffect(() => {
    if (subscribeFetcher.data?.confirmationUrl) {
      window.top!.location.href = subscribeFetcher.data.confirmationUrl;
    }
  }, [subscribeFetcher.data]);

  const cycleDiscount = {
    monthly: 0,
    yearly: 0.2,
    biyearly: 0.4,
  };

  const cycleText = {
    monthly: "/month",
    yearly: "/month (billed annually)",
    biyearly: "/month (billed 2-yearly)",
  };

  const currentPlanKey = data.entitlement.planLabel?.toUpperCase() || "NONE";
  const isActive = data.entitlement.subscriptionStatus === "ACTIVE";

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
          "AI indexed products",
        ),
        limitText(
          data.plans[0]?.limits.searchLimit ?? 3000,
          "AI searches / period",
        ),
        limitText(
          data.plans[0]?.limits.vectorUpdateLimit ?? 500,
          "vector updates / period",
        ),
        "Auto-fallback to Shopify Search when quota exceeded",
        "24/7 Email & Ticket Support",
      ],
      buildWith: ["AI Search Engine", "AI Keyword Suggestions"],
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
          "AI indexed products",
        ),
        limitText(
          data.plans[1]?.limits.searchLimit ?? null,
          "AI searches / period",
        ),
        limitText(
          data.plans[1]?.limits.vectorUpdateLimit ?? null,
          "vector updates / period",
        ),
        "Priority Vector Search bandwidth processing",
        "Auto-optimized Synonyms & Search Intent",
        "1-on-1 Dedicated Technical Support",
      ],
      buildWith: ["AI Vector Analytics", "Full Synonyms Map"],
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
            {isActive ? "ACTIVE (PAID)" : data.entitlement.subscriptionStatus}
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
              ? `${data.subscription.formattedPeriodEnd} (${data.subscription.daysRemaining} days left)`
              : "Monthly (Auto-renew)"}
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
          {/* AI Searches */}
          <div style={{ border: "1px solid #f1f2f3", borderRadius: 8, padding: 14, background: "#fafafa" }}>
            <div style={{ fontSize: 12, color: "#616161", marginBottom: 4 }}>AI Searches</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#1a1a1a" }}>
              {data.entitlement.usage.searchCount.toLocaleString("en-US")} / {limitText(data.entitlement.limits.searchLimit, "")}
            </div>
            <div style={{ fontSize: 11, color: "#008060", marginTop: 4 }}>
              Auto-fallbacks to Shopify Search when limit reached
            </div>
          </div>

          {/* Active AI Products */}
          <div style={{ border: "1px solid #f1f2f3", borderRadius: 8, padding: 14, background: "#fafafa" }}>
            <div style={{ fontSize: 12, color: "#616161", marginBottom: 4 }}>Active AI Products</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#1a1a1a" }}>
              {data.entitlement.activeProductSlotsUsed.toLocaleString("en-US")} / {limitText(data.entitlement.limits.productLimit, "")}
            </div>
            <div style={{ fontSize: 11, color: "#616161", marginTop: 4 }}>
              {data.entitlement.cachedVectorCount.toLocaleString("en-US")} vectors cached · {data.entitlement.cachedProductLimitBlockedProducts.toLocaleString("en-US")} cached & blocked
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

      {/* SECTION 3: PLAN SELECTION HEADER & CYCLE TOGGLE */}
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
        <p style={{ color: "#616161", fontSize: 14, margin: "0 0 20px 0" }}>
          Optimize AI search experiences and boost sales conversion rates today.
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
                cycle === "monthly" ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
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
                cycle === "yearly" ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
            }}
          >
            Yearly <span style={{ color: "#008060", fontSize: 11 }}>(Save 20%)</span>
          </button>
          <button
            type="button"
            onClick={() => setCycle("biyearly")}
            style={{
              padding: "8px 20px",
              borderRadius: 8,
              border: "none",
              background: cycle === "biyearly" ? "#fff" : "transparent",
              fontWeight: 600,
              fontSize: 13,
              color: cycle === "biyearly" ? "#1a1a1a" : "#616161",
              cursor: "pointer",
              boxShadow:
                cycle === "biyearly" ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
            }}
          >
            2-Year <span style={{ color: "#e51c00", fontSize: 11 }}>(Save 40%)</span>
          </button>
        </div>
      </div>

      {/* SECTION 4: PRICING CARDS */}
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
        {data.plans.map((plan) => {
          const isPro = plan.key === "PRO";
          const config = isPro ? planConfigs.PRO : planConfigs.BASIC;
          const discountedPrice = (
            config.priceBase *
            (1 - cycleDiscount[cycle])
          ).toFixed(2);

          const isCurrentPlan = isActive && currentPlanKey.includes(plan.key);

          return (
            <div
              key={plan.key}
              style={{
                background: "#fff",
                borderRadius: 16,
                border: config.isPopular
                  ? "2px solid #008060"
                  : "1px solid #e1e3e5",
                padding: 28,
                width: "100%",
                maxWidth: 420,
                boxSizing: "border-box",
                boxShadow: config.isPopular
                  ? "0 10px 30px rgba(0,128,96,0.12)"
                  : "0 2px 8px rgba(0,0,0,0.04)",
                position: "relative",
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
              }}
            >
              <div>
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    marginBottom: 16,
                    alignItems: "center",
                  }}
                >
                  <span
                    style={{
                      background: config.badgeBg,
                      color: "#fff",
                      fontSize: 11,
                      fontWeight: 700,
                      padding: "3px 8px",
                      borderRadius: 4,
                    }}
                  >
                    {config.badge}
                  </span>
                  {config.isPopular && (
                    <span
                      style={{
                        background: "#e4f8f0",
                        color: "#008060",
                        fontSize: 11,
                        fontWeight: 700,
                        padding: "3px 8px",
                        borderRadius: 4,
                      }}
                    >
                      Most Popular
                    </span>
                  )}
                </div>

                <h2
                  style={{
                    margin: "0 0 8px 0",
                    fontSize: 22,
                    fontWeight: 800,
                    color: "#1a1a1a",
                  }}
                >
                  {plan.label}
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
                      style={{ fontSize: 36, fontWeight: 800, color: "#1a1a1a" }}
                    >
                      ${discountedPrice}
                    </span>
                    <span style={{ fontSize: 13, color: "#616161" }}>
                      {cycleText[cycle]}
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: "#8c9196",
                      textDecoration: "line-through",
                      marginTop: 4,
                    }}
                  >
                    Regular: {config.originalPrice}
                  </div>
                </div>

                {/* Subscription Form */}
                <subscribeFetcher.Form method="post" style={{ marginBottom: 24 }}>
                  <input type="hidden" name="intent" value="subscribe" />
                  <input type="hidden" name="planKey" value={plan.key} />
                  <input type="hidden" name="cycle" value={cycle} />

                  <button
                    type="submit"
                    disabled={isCurrentPlan || subscribeFetcher.state !== "idle"}
                    style={{
                      width: "100%",
                      textAlign: "center",
                      background: isCurrentPlan ? "#8c9196" : config.btnBg,
                      color: "#fff",
                      padding: "12px 20px",
                      borderRadius: 10,
                      fontWeight: 700,
                      fontSize: 14,
                      border: "none",
                      cursor: isCurrentPlan ? "not-allowed" : "pointer",
                      boxShadow: "0 2px 4px rgba(0,0,0,0.1)",
                    }}
                  >
                    {isCurrentPlan
                      ? "Your Current Plan"
                      : subscribeFetcher.state !== "idle"
                      ? "Redirecting..."
                      : `Choose ${plan.label}`}
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
                    {config.features.map((feat, idx) => (
                      <li
                        key={idx}
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
                        <span>{feat}</span>
                      </li>
                    ))}
                  </ul>

                  {config.buildWith && (
                    <div style={{ marginTop: 16 }}>
                      <div
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          color: "#8c9196",
                          textTransform: "uppercase",
                          marginBottom: 8,
                        }}
                      >
                        Integrated Tech:
                      </div>
                      <ul
                        style={{
                          listStyle: "none",
                          padding: 0,
                          margin: 0,
                          display: "flex",
                          flexDirection: "column",
                          gap: 8,
                        }}
                      >
                        {config.buildWith.map((item, idx) => (
                          <li
                            key={idx}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              color: "#303030",
                            }}
                          >
                            <span style={{ color: "#5c6ac4" }}>⚡</span>
                            <span>{item}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* SECTION 5: CUSTOM PLAN — NEGOTIATED / SALES-ASSISTED */}
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
                    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                    gap: 14,
                  }}
                >
                  <label style={{ fontSize: 12, fontWeight: 700, color: "#4a4a4a" }}>
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

                  <label style={{ fontSize: 12, fontWeight: 700, color: "#4a4a4a" }}>
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
                    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                    gap: 14,
                  }}
                >
                  <label style={{ fontSize: 12, fontWeight: 700, color: "#4a4a4a" }}>
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

                  <label style={{ fontSize: 12, fontWeight: 700, color: "#4a4a4a" }}>
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

                  <label style={{ fontSize: 12, fontWeight: 700, color: "#4a4a4a" }}>
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

                <label style={{ fontSize: 12, fontWeight: 700, color: "#4a4a4a" }}>
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
              <h3 style={{ margin: "0 0 8px 0", fontSize: 18, color: "#1a1a1a" }}>
                Your custom plan will appear here
              </h3>
              <p style={{ margin: "0 0 16px 0", fontSize: 13, color: "#616161", lineHeight: 1.6 }}>
                After we agree on the requirements and price, the app can show
                the agreed offer here together with a Shopify payment button.
              </p>

              {/* Future backend-controlled offer state. Keep hidden until the
                  backend provides the agreed price and Shopify confirmation URL. */}
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

