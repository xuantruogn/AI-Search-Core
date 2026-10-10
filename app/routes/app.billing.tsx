import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useFetcher, useLoaderData, useNavigation } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import {
  getShopifyPricingPlansUrl,
  isShopifyAppPricingConfigured,
  refreshShopifyAppPricingSubscription,
  reconcileShopifySubscriptionFromAdmin,
} from "../services/billing/shopify-app-pricing.server";

import { getShopEntitlement } from "../services/commerce/entitlement.server";
import {
  ensureShopFromAdmin,
  getSubscriptionSnapshot,
} from "../services/commerce/shop-registry.server";
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
  const { admin, session } = await authenticate.admin(request);
  console.log("[BILLING DEBUG] loader:authenticated", { debugId, shop: session.shop });

  // A direct visit to Billing after reinstall must use the same authenticated
  // Shopify reconciliation boundary as the dashboard.
  await ensureShopFromAdmin({
    shop: session.shop,
    admin,
  });

  const billingUrl = new URL(request.url);
  const isBillingCallback =
    billingUrl.searchParams.get("billing_callback") === "1";
  const callbackChargeId =
    billingUrl.searchParams.get("charge_id")?.trim() || null;

  if (!isBillingCallback) {
    try {
      const refreshed = await refreshShopifyAppPricingSubscription({
        shop: session.shop,
        admin,
        source: "RECONCILIATION",
      });

      if (refreshed.subscription.shopifySubscriptionId) {
        await reconcileShopifySubscriptionFromAdmin({
          shop: session.shop,
          admin,
          expectedSubscriptionGid:
            refreshed.subscription.shopifySubscriptionId,
          source: "RECONCILIATION",
        });
      }
    } catch (error) {
      console.error("[BILLING REINSTALL] billing-page Shopify reconciliation failed", {
        debugId,
        shop: session.shop,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // The confirmation redirect is a synchronous billing boundary. Do not wait
  // for the webhook/background commercial reconcile to make the UI correct.
  // Re-query Shopify Admin here, persist the confirmed billing state, then
  // calculate entitlement from the fresh local snapshot.
  if (isBillingCallback) {
    try {
      const callbackReconciliation =
        await refreshShopifyAppPricingSubscription({
          shop: session.shop,
          admin,
          source: "CALLBACK",
          providerChargeId: callbackChargeId,
        });

      await reconcileShopCommercialState({
        shop: session.shop,
        forceCatalogRefresh: callbackReconciliation.changed,
      });

      console.log("[BILLING CALLBACK] synchronous reconciliation complete", {
        debugId,
        shop: session.shop,
        chargeId: callbackChargeId,
        status: callbackReconciliation.subscription.status,
        plan: callbackReconciliation.subscription.plan,
        paymentStatus: callbackReconciliation.subscription.paymentStatus,
      });
    } catch (error) {
      console.error("[BILLING CALLBACK] synchronous reconciliation failed", {
        debugId,
        shop: session.shop,
        chargeId: callbackChargeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

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
  console.log("[BILLING TRACE] action:start", {
    debugId,
    method: request.method,
    url: request.url,
    referer: request.headers.get("referer"),
    origin: request.headers.get("origin"),
    secFetchMode: request.headers.get("sec-fetch-mode"),
    secFetchDest: request.headers.get("sec-fetch-dest"),
    contentType: request.headers.get("content-type"),
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

    // Business rule: once a merchant has an active PRO or CUSTOM entitlement,
    // BASIC remains in the catalog but is disabled as a downgrade option.
    // Keep this validation server-side so a crafted POST cannot bypass the UI.
    const currentSubscription = await getSubscriptionSnapshot(session.shop, {
      ensure: false,
    });
    const currentEntitlement = await getShopEntitlement(session.shop);
    const currentPlanHandle =
      currentSubscription.planHandle?.trim().toLowerCase() ?? null;
    const requestedPlanIsCurrent =
      planHandle === currentPlanHandle;

    const currentSubscriptionStillValid =
      currentEntitlement.active &&
      (
        currentSubscription.status === "ACTIVE" ||
        (
          currentSubscription.status === "CANCELLED" &&
          currentSubscription.billingPeriodEnd !== null &&
          currentSubscription.billingPeriodEnd > new Date()
        )
      );

    const samePlanAlreadyPending =
      currentSubscription.status === "PENDING" &&
      requestedPlanIsCurrent;

    if (samePlanAlreadyPending) {
      const pendingSubscriptionGid =
        currentSubscription.shopifySubscriptionId;

      const pendingBillingSubscription = pendingSubscriptionGid
        ? await db.billingSubscription.findUnique({
            where: {
              shopifySubscriptionGid: pendingSubscriptionGid,
            },
            select: {
              rawResponse: true,
            },
          })
        : null;

      const pendingRawResponse =
        pendingBillingSubscription?.rawResponse &&
        typeof pendingBillingSubscription.rawResponse === "object" &&
        !Array.isArray(pendingBillingSubscription.rawResponse)
          ? (pendingBillingSubscription.rawResponse as Record<string, unknown>)
          : null;

      const pendingConfirmationUrl =
        typeof pendingRawResponse?.confirmationUrl === "string" &&
        pendingRawResponse.confirmationUrl.trim().length > 0
          ? pendingRawResponse.confirmationUrl.trim()
          : null;

      console.log("[BILLING TRACE] pending:reuse-approval", {
        debugId,
        shop: session.shop,
        planHandle,
        subscriptionGid: pendingSubscriptionGid,
        hasConfirmationUrl: Boolean(pendingConfirmationUrl),
      });

      if (pendingConfirmationUrl) {
        return {
          success: true,
          message: `The ${currentSubscription.planLabel} subscription is still awaiting approval. Opening Shopify approval.`,
          confirmationUrl: pendingConfirmationUrl,
        };
      }

      return {
        success: false,
        message:
          `The ${currentSubscription.planLabel} subscription is already awaiting approval, but its Shopify approval URL is unavailable. Do not create another subscription; refresh the billing page and retry.`,
      };
    }

    if (requestedPlanIsCurrent && currentSubscriptionStillValid) {
      return {
        success: false,
        message: `The ${currentSubscription.planLabel} subscription is already active for this billing period.`,
      };
    }

    const hasActiveHigherTier =
      currentEntitlement.active &&
      (currentPlanHandle === "pro" || currentPlanHandle === "custom");

    if (hasActiveHigherTier && planHandle === "basic") {
      return {
        success: false,
        message:
          "Downgrading from PRO or CUSTOM to BASIC is not available for this store.",
      };
    }

    // Trial eligibility is shop-wide, not plan-specific. Prefer the immutable
    // approval event, and also check historical subscription rows so shops
    // activated before event logging was introduced cannot receive another trial.
    const [priorApprovalEvent, priorActivatedSubscription] = await Promise.all([
      db.billingEvent.findFirst({
        where: {
          shop: session.shop,
          type: "SUBSCRIPTION_APPROVED",
        },
        select: { id: true },
      }),
      db.billingSubscription.findFirst({
        where: {
          shop: session.shop,
          activatedAt: { not: null },
        },
        select: { id: true },
      }),
    ]);
    const hasEverApprovedSubscription = Boolean(
      priorApprovalEvent || priorActivatedSubscription,
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
      const configuredAppHandle = process.env.SHOPIFY_APP_HANDLE?.trim() || "";
      const configuredApiKey = process.env.SHOPIFY_API_KEY?.trim() || "";
      const appIdentifier = configuredAppHandle || configuredApiKey;
      const appIdentifierSource = configuredAppHandle
        ? "SHOPIFY_APP_HANDLE"
        : configuredApiKey
          ? "SHOPIFY_API_KEY_FALLBACK"
          : "NONE";

      console.log("[BILLING TRACE] env:billing-config", {
        debugId,
        shop: session.shop,
        billingTestMode,
        hasShopifyAppHandle: Boolean(configuredAppHandle),
        hasShopifyApiKey: Boolean(configuredApiKey),
        appIdentifierSource,
        hasShopifyAppUrl: Boolean(process.env.SHOPIFY_APP_URL?.trim()),
        hasShopifyApiSecret: Boolean(process.env.SHOPIFY_API_SECRET?.trim()),
        nodeEnv: process.env.NODE_ENV ?? null,
      });

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

      console.log("[BILLING TRACE] appSubscriptionCreate:response", {
        debugId,
        shop: session.shop,
        httpStatus: response.status,
        httpOk: response.ok,
        responseContentType: response.headers.get("content-type"),
        responseHasErrors: Boolean(responseJson.errors?.length),
        userErrors: subscriptionData?.userErrors ?? [],
        subscriptionId: subscriptionData?.appSubscription?.id ?? null,
        subscriptionStatus: subscriptionData?.appSubscription?.status ?? null,
        confirmationUrl: subscriptionData?.confirmationUrl ?? null,
        returnUrl: returnUrl.toString(),
      });

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

      console.log("[BILLING TRACE] checkpoint:after-pending-update", {
        debugId,
        shop: session.shop,
        subscriptionId: createdSubscription.id,
      });

      console.log("[BILLING TRACE] checkpoint:before-reconcile", {
        debugId,
        shop: session.shop,
        subscriptionId: createdSubscription.id,
      });

      await reconcileShopifySubscriptionFromAdmin({
        shop: session.shop,
        admin,
        expectedSubscriptionGid: createdSubscription.id,
        preferredPlanHandle: billingPlan.handle,
        authoritativePlanHandle: billingPlan.handle,
        source: "CALLBACK",
        confirmationUrl: subscriptionData?.confirmationUrl?.trim() || null,
      });

      const confirmationUrl = subscriptionData?.confirmationUrl?.trim() || null;

      if (confirmationUrl) {
        const pendingBillingSubscription =
          await db.billingSubscription.findUnique({
            where: {
              shopifySubscriptionGid: createdSubscription.id,
            },
            select: {
              rawResponse: true,
            },
          });

        const rawResponse =
          pendingBillingSubscription?.rawResponse &&
          typeof pendingBillingSubscription.rawResponse === "object" &&
          !Array.isArray(pendingBillingSubscription.rawResponse)
            ? (pendingBillingSubscription.rawResponse as Record<string, unknown>)
            : {};

        await db.billingSubscription.update({
          where: {
            shopifySubscriptionGid: createdSubscription.id,
          },
          data: {
            rawResponse: {
              ...rawResponse,
              confirmationUrl,
              confirmationUrlStoredAt: new Date().toISOString(),
            },
          },
        });
      }

      console.log("[BILLING TRACE] checkpoint:after-reconcile", {
        debugId,
        shop: session.shop,
        subscriptionId: createdSubscription.id,
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

      console.log("[BILLING TRACE] redirect:before", {
        debugId,
        shop: session.shop,
        subscriptionId: createdSubscription.id,
        confirmationUrl: confirmationUrl ?? null,
        returnUrl: returnUrl.toString(),
        requestMethod: request.method,
        secFetchMode: request.headers.get("sec-fetch-mode"),
        secFetchDest: request.headers.get("sec-fetch-dest"),
        origin: request.headers.get("origin"),
        referer: request.headers.get("referer"),
      });

      if (confirmationUrl) {
        console.log("[BILLING TRACE] action:confirmation-url-ready", {
          debugId,
          shop: session.shop,
          subscriptionId: createdSubscription.id,
          confirmationUrl,
        });

        return {
          success: true,
          message: "Subscription created. Opening Shopify approval.",
          confirmationUrl,
        };
      }

      return {
        success: false,
        message: "Failed to create payment link.",
      };
    } catch (error) {
      console.error("[BILLING TRACE] subscribe:FAILED", {
        debugId,
        shop: session.shop,
        error,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

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
  const navigation = useNavigation();
  const [pendingPlanHandle, setPendingPlanHandle] = useState<string | null>(null);
  if (!data) return null;

  const actionData = useActionData<typeof action>();

  useEffect(() => {
    const confirmationUrl = subscribeFetcher.data?.confirmationUrl;

    if (!confirmationUrl) return;

    console.log("[BILLING TRACE] client:navigate-to-confirmation", {
      confirmationUrl,
    });

    window.top!.location.href = confirmationUrl;
  }, [subscribeFetcher.data]);

  useEffect(() => {
    if (
      subscribeFetcher.state === "idle" &&
      subscribeFetcher.data &&
      "success" in subscribeFetcher.data &&
      subscribeFetcher.data.success === false
    ) {
      setPendingPlanHandle(null);
    }
  }, [subscribeFetcher.data, subscribeFetcher.state]);

  useEffect(() => {
    if (
      navigation.state === "idle" &&
      actionData &&
      "success" in actionData &&
      actionData.success === false
    ) {
      setPendingPlanHandle(null);
    }
  }, [actionData, navigation.state]);

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
  const isNonRenewing = data.entitlement.cancellationStatus === "NON_RENEWING";
  const isActive = data.entitlement.active;
  const hideBasicPlan =
    isActive &&
    (currentPlanHandle === "pro" || currentPlanHandle === "custom");
  const availablePlans = (data.customPlan
    ? [...data.plans, data.customPlan]
    : data.plans
  ).filter(
    (plan) => !(hideBasicPlan && plan.handle.toLowerCase() === "basic"),
  );
  const comparisonFeatureCatalog = Array.from(
    new Map(
      availablePlans
        .flatMap((plan) => plan.merchantFeatures ?? [])
        .map((feature) => [feature.key, { key: feature.key, label: feature.label }]),
    ).values(),
  );
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
              Subscription lifecycle
            </div>
            <div style={{ fontSize: 12, color: "#4a4a4a", marginTop: 6 }}>
              {isNonRenewing
                ? `Shopify has marked this subscription as not renewing. Your ${data.entitlement.planLabel} plan remains available until ${data.subscription.formattedPeriodEnd ?? "the end of the current billing period"}.`
                : "Your subscription is currently active. AI-Buyense does not provide an in-app control to cancel or disable renewal; subscription lifecycle changes are received from Shopify and synchronized here."}
            </div>
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

        <div
          style={{
            display: "grid",
            gridTemplateColumns:
              availablePlans.length === 1
                ? "minmax(0, 520px)"
                : "repeat(auto-fit, minmax(270px, 1fr))",
            justifyContent: availablePlans.length === 1 ? "center" : undefined,
            gap: 18,
            alignItems: "stretch",
            width: "100%",
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
            const isSubmitting = subscribeFetcher.state !== "idle";
            const isSubmittingThisPlan =
              isSubmitting &&
              subscribeFetcher.formData?.get("planHandle") === plan.handle;

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
                    disabled={isCurrentPlan || isSubmitting}
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
                      cursor: isCurrentPlan || isSubmitting ? "not-allowed" : "pointer",
                    }}
                  >
                    {isCurrentPlan
                      ? "Current plan"
                      : isSubmittingThisPlan
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
        All app charges are billed directly through your monthly Shopify Invoice. Available plan changes are confirmed through Shopify Billing.
      </div>
    </div>
  );
}