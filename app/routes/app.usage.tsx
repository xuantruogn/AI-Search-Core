import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import { getShopEntitlement } from "../services/commerce/entitlement.server";
import {
  getRecentUsageEvents,
  getUsageEventTypeCounts,
} from "../services/commerce/usage.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const entitlement = await getShopEntitlement(session.shop);
  const [events, eventCounts] = await Promise.all([
    getRecentUsageEvents(session.shop, 50),
    getUsageEventTypeCounts(session.shop, entitlement.usage.id),
  ]);

  return {
    entitlement,
    eventCounts,
    events: events.map((event) => ({
      ...event,
      success: Boolean(event.success),
      createdAt:
        event.createdAt instanceof Date
          ? event.createdAt.toISOString()
          : new Date(event.createdAt).toISOString(),
      queryHash: event.queryHash ? `${event.queryHash.slice(0, 12)}…` : null,
    })),
  };
};

export default function UsagePage() {
  const data = useLoaderData<typeof loader>();
  const usage = data.entitlement.usage;

  return (
    <s-page heading="Usage & Logs">
      <s-section heading="Counters kỳ hiện tại">
        <s-stack direction="block" gap="base">
          <s-text>
            Kỳ usage: {new Date(usage.periodStart).toLocaleDateString("vi-VN")}{" "}
            → {new Date(usage.periodEnd).toLocaleDateString("vi-VN")}
          </s-text>
          <s-text>
            Tổng lượt search storefront:{" "}
            {usage.searchCount + usage.fallbackCount}
          </s-text>
          <s-text>
            AI searches thành công: {usage.searchCount}
            {data.entitlement.limits.searchLimit === null
              ? " / Không giới hạn"
              : ` / ${data.entitlement.limits.searchLimit}`}
          </s-text>
          <s-text>
            Vector updates: {usage.vectorUpdateCount}
            {data.entitlement.limits.vectorUpdateLimit === null
              ? " / Không giới hạn"
              : ` / ${data.entitlement.limits.vectorUpdateLimit}`}
          </s-text>
          <s-text>Query embeddings: {usage.queryEmbeddingCount}</s-text>
          <s-text>Product embeddings: {usage.productEmbeddingCount}</s-text>
          <s-text>Initial product indexes: {usage.productIndexCount}</s-text>
          <s-text>Product deletes: {usage.productDeleteCount}</s-text>
          <s-text>
            Product sync events: {data.eventCounts.PRODUCT_SYNC ?? 0}
          </s-text>
          <s-text>Fallbacks: {usage.fallbackCount}</s-text>
          <s-text>Blocked searches: {usage.blockedSearchCount}</s-text>
          <s-text>Blocked vector updates: {usage.blockedVectorCount}</s-text>
          <s-text>
            Products indexed: {data.entitlement.indexedProducts}
            {data.entitlement.limits.productLimit === null
              ? " / Không giới hạn"
              : ` / ${data.entitlement.limits.productLimit}`}
          </s-text>
          <s-text>
            Product-limit blocked:{" "}
            {data.entitlement.productLimitBlockedProducts}
          </s-text>
          <s-text>
            Vector-quota blocked products:{" "}
            {data.entitlement.vectorQuotaBlockedProducts}
          </s-text>
          <s-text>
            Subscription-blocked products:{" "}
            {data.entitlement.subscriptionBlockedProducts}
          </s-text>
        </s-stack>
      </s-section>

      <s-section heading="50 usage events gần nhất">
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {[
                  "Time",
                  "Type",
                  "Success",
                  "Qty",
                  "Product",
                  "Query hash",
                  "Metadata",
                ].map((heading) => (
                  <th
                    key={heading}
                    style={{
                      textAlign: "left",
                      padding: 8,
                      borderBottom: "1px solid #ddd",
                    }}
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.events.map((event) => (
                <tr key={event.id}>
                  <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>
                    {new Date(event.createdAt).toLocaleString("vi-VN")}
                  </td>
                  <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>
                    {event.type}
                  </td>
                  <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>
                    {event.success ? "YES" : "NO"}
                  </td>
                  <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>
                    {event.quantity}
                  </td>
                  <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>
                    {event.productId ?? "—"}
                  </td>
                  <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>
                    {event.queryHash ?? "—"}
                  </td>
                  <td
                    style={{
                      padding: 8,
                      borderBottom: "1px solid #eee",
                      maxWidth: 360,
                      wordBreak: "break-word",
                    }}
                  >
                    {event.metadataJson ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </s-section>
    </s-page>
  );
}
