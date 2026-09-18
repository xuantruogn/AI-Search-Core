import { useState } from "react";
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

type Cycle = "monthly" | "yearly" | "biyearly";

export default function BillingPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [cycle, setCycle] = useState<Cycle>("monthly");

  const cycleDiscount = {
    monthly: 0,
    yearly: 0.2,
    biyearly: 0.4,
  };

  const cycleText = {
    monthly: "/tháng",
    yearly: "/tháng (thanh toán hàng năm)",
    biyearly: "/tháng (thanh toán 2 năm)",
  };

  const planConfigs = {
    BASIC: {
      badge: "Phổ biến",
      badgeBg: "#008060",
      priceBase: 9.9,
      originalPrice: "$14.99/tháng",
      isPopular: false,
      btnBg: "#008060",
      features: [
        limitText(
          data.plans[0]?.limits.productLimit ?? 500,
          "sản phẩm được AI index",
        ),
        limitText(
          data.plans[0]?.limits.searchLimit ?? 2000,
          "AI searches / kỳ",
        ),
        limitText(
          data.plans[0]?.limits.vectorUpdateLimit ?? 500,
          "vector updates / kỳ",
        ),
        "Tự động fallback về Shopify Search khi hết quota",
        "Hỗ trợ qua Email & Ticket 24/7",
      ],
      buildWith: ["AI Search Engine", "Gợi ý từ khóa AI"],
    },
    PRO: {
      badge: "Tiết kiệm 40%",
      badgeBg: "#e51c00",
      priceBase: 29.9,
      originalPrice: "$49.99/tháng",
      isPopular: true,
      btnBg: "#e51c00",
      features: [
        limitText(
          data.plans[1]?.limits.productLimit ?? null,
          "sản phẩm được AI index",
        ),
        limitText(
          data.plans[1]?.limits.searchLimit ?? null,
          "AI searches / kỳ",
        ),
        limitText(
          data.plans[1]?.limits.vectorUpdateLimit ?? null,
          "vector updates / kỳ",
        ),
        "Ưu tiên xử lý băng thông Vector Search",
        "Tự động tối ưu Synonyms & Search Intent",
        "Hỗ trợ kỹ thuật 1-1 chuyên sâu",
      ],
      buildWith: ["AI Vector Analytics", "Full Synonyms Map"],
      included: ["Tối ưu hóa tìm kiếm không kết quả"],
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
      {/* KHỐI 1: TỔNG QUAN GÓI HIỆN TẠI */}
      <div
        style={{
          background: "#fff",
          borderRadius: 12,
          padding: 24,
          border: "1px solid #e1e3e5",
          marginBottom: 32,
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
            style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#1a1a1a" }}
          >
            Trạng thái gói hiện tại
          </h2>
          <span
            style={{
              padding: "4px 12px",
              borderRadius: 20,
              fontSize: 12,
              fontWeight: 700,
              background:
                data.entitlement.subscriptionStatus === "ACTIVE"
                  ? "#e4f8f0"
                  : "#ffebe9",
              color:
                data.entitlement.subscriptionStatus === "ACTIVE"
                  ? "#008060"
                  : "#d32f2f",
            }}
          >
            {data.entitlement.subscriptionStatus}
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
            <strong>Cửa hàng:</strong> {data.shop}
          </div>
          <div>
            <strong>Gói đang dùng:</strong> {data.entitlement.planLabel}
          </div>
          <div>
            <strong>Nguồn:</strong> {data.subscription.source}
          </div>
          <div>
            <strong>Partner API:</strong>{" "}
            {data.partnerApiConfigured ? "🟢 Đã kết nối" : "🔴 Chưa cấu hình"}
          </div>
        </div>

        <div
          style={{
            marginTop: 20,
            paddingTop: 16,
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
                ? "Đang đồng bộ..."
                : "Đồng bộ trạng thái Billing"}
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
              Mở trang quản lý đăng ký của Shopify →
            </a>
          )}
        </div>
        {fetcher.data ? (
          <p style={{ margin: "10px 0 0 0", fontSize: 12, color: "#008060" }}>
            {fetcher.data.message}
          </p>
        ) : null}
      </div>

      {/* KHỐI 2: HEADER CHỌN GÓI & TOGGLE CHU KỲ */}
      <div style={{ textAlign: "center", marginBottom: 36 }}>
        <h1
          style={{
            fontSize: 28,
            fontWeight: 800,
            color: "#1a1a1a",
            margin: "0 0 8px 0",
          }}
        >
          Chọn gói dịch vụ phù hợp cho cửa hàng
        </h1>
        <p style={{ color: "#616161", fontSize: 14, margin: "0 0 24px 0" }}>
          Tối ưu trải nghiệm tìm kiếm AI, tăng tỷ lệ chuyển đổi đơn hàng ngay hôm nay.
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
            Hàng tháng
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
            Hàng năm <span style={{ color: "#008060", fontSize: 11 }}>(Giảm 20%)</span>
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
            2 Năm <span style={{ color: "#e51c00", fontSize: 11 }}>(Giảm 40%)</span>
          </button>
        </div>
      </div>

      {/* KHỐI 3: DANH SÁCH 2 GÓI */}
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
                  ? "0 8px 24px rgba(0,128,96,0.12)"
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
                      Đăng ký nhiều nhất
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
                    Giá gốc: {config.originalPrice}
                  </div>
                </div>

                <a
                  href={data.pricingUrl || "#"}
                  target="_top"
                  style={{
                    display: "block",
                    textAlign: "center",
                    background: config.btnBg,
                    color: "#fff",
                    padding: "12px 20px",
                    borderRadius: 10,
                    fontWeight: 700,
                    fontSize: 14,
                    textDecoration: "none",
                    marginBottom: 24,
                    boxShadow: "0 2px 4px rgba(0,0,0,0.1)",
                  }}
                >
                  Chọn gói {plan.label}
                </a>

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
                    Tính năng bao gồm:
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
                        Công nghệ tích hợp:
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
    </div>
  );
}