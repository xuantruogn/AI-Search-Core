import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import { getShopEntitlement } from "../services/commerce/entitlement.server";
import { getProductSyncQueueStats } from "../services/products/product-sync-job.server";
import { getLatestCatalogSyncJob } from "../services/catalog/catalog-sync-job.server";
import { getShopifyPricingPlansUrl } from "../services/billing/shopify-app-pricing.server";
import { getThemeAppEmbedDeepLink } from "../services/theme/app-embed.server";
import { getThemeIntegrationStatus } from "../services/theme/theme-integration.server";

function formatLimit(value: number | null) {
  return value === null ? "Không giới hạn" : value.toLocaleString("vi-VN");
}

function formatUsage(used: number, limit: number | null) {
  return `${used.toLocaleString("vi-VN")} / ${formatLimit(limit)}`;
}

// Client-safe helper. Do not import utility functions used by route components
// from a `.server` module: React Router must be able to split the route into
// server loader/action code and a browser bundle.
function remaining(limit: number | null, used: number) {
  if (limit === null) return null;
  return Math.max(0, limit - used);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const [entitlement, queue, catalogJob, themeIntegration] = await Promise.all([
    getShopEntitlement(session.shop),
    getProductSyncQueueStats(session.shop),
    getLatestCatalogSyncJob(session.shop),
    getThemeIntegrationStatus({ admin, shop: session.shop }),
  ]);

  return {
    shop: session.shop,
    entitlement,
    queue,
    catalogJob: catalogJob
      ? {
          id: catalogJob.id,
          status: catalogJob.status,
          productsProcessed: catalogJob.productsProcessed,
          productsIndexed: catalogJob.productsIndexed,
          productsSkipped: catalogJob.productsSkipped,
          productsBlocked: catalogJob.productsBlocked,
          productsFailed: catalogJob.productsFailed,
          lastError: catalogJob.lastError,
        }
      : null,
    pricingUrl: getShopifyPricingPlansUrl(session.shop),
    appEmbed: themeIntegration.appEmbed,
    themeIntegration,
    appEmbedUrl: getThemeAppEmbedDeepLink(session.shop),
  };
};

function MetricCard({
  title,
  value,
  detail,
}: {
  title: string;
  value: string;
  detail?: string;
}) {
  return (
    <div
      style={{
        border: "1px solid #e1e3e5",
        borderRadius: 12,
        padding: 16,
        minWidth: 210,
        flex: "1 1 210px",
      }}
    >
      <div style={{ fontSize: 13, color: "#616161", marginBottom: 6 }}>
        {title}
      </div>
      <div style={{ fontSize: 24, fontWeight: 650 }}>{value}</div>
      {detail ? (
        <div style={{ marginTop: 6, color: "#616161" }}>{detail}</div>
      ) : null}
    </div>
  );
}

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();
  const { entitlement } = data;

  const searchRemaining = remaining(
    entitlement.limits.searchLimit,
    entitlement.usage.searchCount,
  );
  const vectorRemaining = remaining(
    entitlement.limits.vectorUpdateLimit,
    entitlement.usage.vectorUpdateCount,
  );

  return (
    <s-page heading="AI Search Bridge">
      <s-section heading="Trạng thái cửa hàng">
        <s-stack direction="block" gap="base">
          <s-text>Shop: {data.shop}</s-text>
          <s-text>Gói: {entitlement.planLabel}</s-text>
          <s-text>Subscription: {entitlement.subscriptionStatus}</s-text>
          <s-text>
            AI Search:{" "}
            {entitlement.searchAllowed
              ? "ĐANG HOẠT ĐỘNG"
              : "ĐANG FALLBACK SHOPIFY"}
          </s-text>
          {!entitlement.searchAllowed ? (
            <s-text>Lý do: {entitlement.disabledReason ?? "UNKNOWN"}</s-text>
          ) : null}
          {data.pricingUrl ? (
            <s-link href={data.pricingUrl} target="_top">
              Xem / thay đổi gói trên Shopify
            </s-link>
          ) : null}
        </s-stack>
      </s-section>

      <s-section heading="Onboarding & kích hoạt storefront">
        <s-stack direction="block" gap="base">
          <s-text>
            1. Subscription:{" "}
            {entitlement.active ? "SẴN SÀNG" : "CẦN GÓI ACTIVE"}
          </s-text>
          <s-text>
            2. Catalog:{" "}
            {data.catalogJob?.status === "DONE"
              ? "ĐÃ ĐỒNG BỘ"
              : (data.catalogJob?.status ?? "CHƯA ĐỒNG BỘ")}
          </s-text>
          <s-text>
            3. Theme App Embed:{" "}
            {data.appEmbed.enabled === true
              ? "ĐÃ BẬT"
              : data.appEmbed.enabled === false
                ? "CHƯA BẬT"
                : "CHƯA XÁC ĐỊNH"}
            {data.appEmbed.themeName
              ? ` · Theme: ${data.appEmbed.themeName}`
              : ""}
          </s-text>
          <s-text>
            4. Theme Renderer: {data.themeIntegration.rendererCompatible ? "TƯƠNG THÍCH" : "CHƯA TƯƠNG THÍCH"}
            {data.themeIntegration.rendererSource ? ` · ${data.themeIntegration.rendererSource}` : ""}
          </s-text>
          <s-text>
            Integration: {data.themeIntegration.status}
          </s-text>
          {data.appEmbed.enabled !== true && data.appEmbedUrl ? (
            <>
              <s-link href={data.appEmbedUrl} target="_top">
                Mở Theme Editor để bật AI Search Bridge
              </s-link>
              <s-text>
                Trong Theme Editor, bật App Embed “AI Search Bridge” rồi bấm
                Save.
              </s-text>
            </>
          ) : null}
        </s-stack>
      </s-section>

      <s-section heading="Usage kỳ hiện tại">
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <MetricCard
            title="Sản phẩm AI indexed"
            value={formatUsage(
              entitlement.indexedProducts,
              entitlement.limits.productLimit,
            )}
          />
          <MetricCard
            title="AI Searches"
            value={formatUsage(
              entitlement.usage.searchCount,
              entitlement.limits.searchLimit,
            )}
            detail={
              searchRemaining === null
                ? "Unlimited - vẫn ghi log"
                : `Còn ${searchRemaining.toLocaleString("vi-VN")}`
            }
          />
          <MetricCard
            title="Vector updates"
            value={formatUsage(
              entitlement.usage.vectorUpdateCount,
              entitlement.limits.vectorUpdateLimit,
            )}
            detail={
              vectorRemaining === null
                ? "Unlimited - vẫn ghi log"
                : `Còn ${vectorRemaining.toLocaleString("vi-VN")}`
            }
          />
          <MetricCard
            title="Product embeddings"
            value={entitlement.usage.productEmbeddingCount.toLocaleString(
              "vi-VN",
            )}
            detail="Dùng để theo dõi chi phí OpenAI"
          />
          <MetricCard
            title="Sản phẩm bị chặn bởi product limit"
            value={entitlement.productLimitBlockedProducts.toLocaleString(
              "vi-VN",
            )}
            detail="Sẽ được xét lại khi có slot / nâng gói"
          />
          <MetricCard
            title="Sản phẩm chờ vector quota"
            value={entitlement.vectorQuotaBlockedProducts.toLocaleString(
              "vi-VN",
            )}
            detail="Được phục hồi khi quota kỳ mới khả dụng"
          />
        </div>
      </s-section>

      <s-section heading="Độ tin cậy đồng bộ">
        <s-stack direction="block" gap="base">
          <s-text>
            Product queue: PENDING {data.queue.pending} · PROCESSING{" "}
            {data.queue.processing} · FAILED {data.queue.failed} · DONE{" "}
            {data.queue.done}
          </s-text>
          {data.catalogJob ? (
            <>
              <s-text>
                Initial catalog sync: {data.catalogJob.status} (job #
                {data.catalogJob.id})
              </s-text>
              <s-text>
                Processed {data.catalogJob.productsProcessed} · Indexed{" "}
                {data.catalogJob.productsIndexed} · Skipped{" "}
                {data.catalogJob.productsSkipped} · Blocked{" "}
                {data.catalogJob.productsBlocked} · Failed{" "}
                {data.catalogJob.productsFailed}
              </s-text>
              {data.catalogJob.lastError ? (
                <s-text>Error: {data.catalogJob.lastError}</s-text>
              ) : null}
            </>
          ) : (
            <s-text>Chưa có initial catalog sync job.</s-text>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Theo dõi chi phí & fallback">
        <s-stack direction="block" gap="base">
          <s-text>
            Tổng lượt tìm kiếm storefront:{" "}
            {entitlement.usage.searchCount + entitlement.usage.fallbackCount}
          </s-text>
          <s-text>
            AI searches thành công: {entitlement.usage.searchCount}
          </s-text>
          <s-text>
            Query embeddings: {entitlement.usage.queryEmbeddingCount}
          </s-text>
          <s-text>
            Fallback về Shopify Search: {entitlement.usage.fallbackCount}
          </s-text>
          <s-text>
            Search bị chặn quota: {entitlement.usage.blockedSearchCount}
          </s-text>
          <s-text>
            Vector update bị chặn quota: {entitlement.usage.blockedVectorCount}
          </s-text>
          <s-text>
            Kỳ usage:{" "}
            {new Date(entitlement.usage.periodStart).toLocaleDateString(
              "vi-VN",
            )}{" "}
            →{" "}
            {new Date(entitlement.usage.periodEnd).toLocaleDateString("vi-VN")}
          </s-text>
        </s-stack>
      </s-section>
    </s-page>
  );
}
