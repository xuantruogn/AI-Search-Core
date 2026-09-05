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
  // Entitlement bootstraps the tenant rows. Read the subscription afterwards
  // without a second ensure/write path to reduce SQLite contention on a fresh
  // install when nested route loaders run concurrently.
  const entitlement = await getShopEntitlement(session.shop);
  const subscription = await getSubscriptionSnapshot(session.shop, {
    ensure: false,
  });

  return {
    shop: session.shop,
    entitlement,
    subscription: {
      ...subscription,
      billingPeriodStart:
        subscription.billingPeriodStart?.toISOString() ?? null,
      billingPeriodEnd: subscription.billingPeriodEnd?.toISOString() ?? null,
      lastSyncedAt: subscription.lastSyncedAt?.toISOString() ?? null,
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

  if (intent !== "refresh") {
    return {
      success: false,
      message: "Unsupported billing action",
    };
  }

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
        : "Partner API chưa được cấu hình; đang dùng subscription state local/dev.",
    };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
};

function limitText(value: number | null, suffix: string) {
  return value === null
    ? `Không giới hạn ${suffix}`
    : `${value.toLocaleString("vi-VN")} ${suffix}`;
}

export default function BillingPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  return (
    <s-page heading="Plans & Billing">
      <s-section heading="Gói hiện tại">
        <s-stack direction="block" gap="base">
          <s-text>Shop: {data.shop}</s-text>
          <s-text>Plan: {data.entitlement.planLabel}</s-text>
          <s-text>Status: {data.entitlement.subscriptionStatus}</s-text>
          <s-text>Source: {data.subscription.source}</s-text>
          <s-text>Plan handle: {data.subscription.planHandle ?? "—"}</s-text>
          <s-text>
            Billing period: {data.subscription.billingPeriodStart ?? "—"} →{" "}
            {data.subscription.billingPeriodEnd ?? "—"}
          </s-text>
          <s-text>
            Partner API:{" "}
            {data.partnerApiConfigured ? "Đã cấu hình" : "Chưa cấu hình"}
          </s-text>
          {data.pricingUrl ? (
            <s-link href={data.pricingUrl} target="_top">
              Mở trang chọn gói của Shopify
            </s-link>
          ) : (
            <s-text>
              Chưa có SHOPIFY_APP_HANDLE nên chưa thể tạo link hosted pricing
              page.
            </s-text>
          )}

          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="refresh" />
            <s-button
              type="submit"
              {...(fetcher.state !== "idle" ? { loading: true } : {})}
            >
              Đồng bộ trạng thái billing
            </s-button>
          </fetcher.Form>

          {fetcher.data ? <s-text>{fetcher.data.message}</s-text> : null}
        </s-stack>
      </s-section>

      <s-section heading="Các gói dự kiến">
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          {data.plans.map((plan) => (
            <div
              key={plan.key}
              style={{
                border: "1px solid #d9d9d9",
                borderRadius: 12,
                padding: 18,
                flex: "1 1 280px",
                maxWidth: 480,
              }}
            >
              <h2 style={{ marginTop: 0 }}>{plan.label}</h2>
              <p>{plan.description}</p>
              <ul>
                <li>
                  {limitText(
                    plan.limits.productLimit,
                    "sản phẩm được AI index",
                  )}
                </li>
                <li>
                  {limitText(plan.limits.searchLimit, "AI searches / kỳ")}
                </li>
                <li>
                  {limitText(
                    plan.limits.vectorUpdateLimit,
                    "vector updates / kỳ",
                  )}
                </li>
                <li>Usage vẫn được ghi log để tính chi phí và tải hệ thống.</li>
                <li>Hết quota AI → fallback Shopify Search mặc định.</li>
              </ul>
            </div>
          ))}
        </div>
      </s-section>

      <s-section heading="Biến môi trường production cần có">
        <pre style={{ whiteSpace: "pre-wrap" }}>{`SHOPIFY_APP_HANDLE=...
SHOPIFY_APP_GID=gid://shopify/App/...
SHOPIFY_PARTNER_ORG_ID=...
SHOPIFY_PARTNER_API_ACCESS_TOKEN=...
AI_SEARCH_BASIC_PLAN_HANDLES=basic,basic_plan
AI_SEARCH_PRO_PLAN_HANDLES=pro,pro_plan`}</pre>
      </s-section>
    </s-page>
  );
}
