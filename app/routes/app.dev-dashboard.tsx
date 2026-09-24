import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";

import { authenticate } from "../shopify.server";
import { assertDevDashboardAccess } from "../services/admin/dev-dashboard-access.server";
import {
  getDevDashboardData,
  resolveGrantExpiry,
} from "../services/admin/dev-dashboard.server";
import {
  createQuotaGrant,
  QUOTA_GRANT_KIND,
  revokeQuotaGrant,
  setAbsoluteQuotaOverridesWithAudit,
  setShopAiEnabledWithAudit,
  type QuotaGrantKind,
} from "../services/commerce/quota-grants.server";

function parseNullableNonNegative(form: FormData, name: string) {
  const raw = String(form.get(name) ?? "").trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be blank or >= 0`);
  }
  return Math.trunc(value);
}

function requireReason(form: FormData) {
  const reason = String(form.get("reason") ?? "").trim();
  if (reason.length < 3) throw new Error("Reason is required");
  return reason;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  assertDevDashboardAccess(session.shop);

  const url = new URL(request.url);
  return getDevDashboardData(url.searchParams.get("q") ?? "");
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  assertDevDashboardAccess(session.shop);

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const targetShop = String(form.get("targetShop") ?? "").trim();

  try {
    if (intent === "grant_quota") {
      const kind = String(form.get("kind") ?? "") as QuotaGrantKind;
      if (!Object.values(QUOTA_GRANT_KIND).includes(kind)) {
        throw new Error("Invalid grant kind");
      }
      const amount = Number(form.get("amount"));
      const reason = requireReason(form);
      const expiryMode = String(
        form.get("expiryMode") ?? "BILLING_CYCLE",
      ) as "BILLING_CYCLE" | "30_DAYS" | "NEVER";
      const expiresAt = await resolveGrantExpiry(targetShop, expiryMode);

      await createQuotaGrant({
        actorShop: session.shop,
        targetShop,
        kind,
        amount,
        reason,
        expiresAt,
      });
      return { ok: true, message: `Granted ${amount} ${kind} to ${targetShop}.` };
    }

    if (intent === "revoke_grant") {
      await revokeQuotaGrant({
        actorShop: session.shop,
        grantId: String(form.get("grantId") ?? ""),
        reason: requireReason(form),
      });
      return { ok: true, message: "Grant revoked." };
    }

    if (intent === "set_limits") {
      await setAbsoluteQuotaOverridesWithAudit({
        actorShop: session.shop,
        targetShop,
        productLimitOverride: parseNullableNonNegative(
          form,
          "productLimitOverride",
        ),
        searchLimitOverride: parseNullableNonNegative(
          form,
          "searchLimitOverride",
        ),
        vectorUpdateLimitOverride: parseNullableNonNegative(
          form,
          "vectorUpdateLimitOverride",
        ),
        reason: requireReason(form),
      });
      return { ok: true, message: `Absolute support limits updated for ${targetShop}.` };
    }

    if (intent === "toggle_ai") {
      const enabled = String(form.get("enabled")) === "true";
      await setShopAiEnabledWithAudit({
        actorShop: session.shop,
        targetShop,
        enabled,
        reason: requireReason(form),
      });
      return {
        ok: true,
        message: `AI Search ${enabled ? "enabled" : "disabled"} for ${targetShop}.`,
      };
    }

    throw new Error("Unknown action");
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

const cardStyle = {
  border: "1px solid #dfe3e8",
  borderRadius: 12,
  padding: 16,
  background: "white",
} as const;

function fmtUsd(value: number | null) {
  return value === null ? "Not configured" : `$${value.toFixed(4)}`;
}

function fmtDate(value: string | Date | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function progress(used: number, limit: number | null) {
  if (limit === null) return "Unlimited";
  return `${used.toLocaleString()} / ${limit.toLocaleString()}`;
}

export default function DevDashboard() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <main
      style={{
        maxWidth: 1500,
        margin: "0 auto",
        padding: 24,
        fontFamily:
          "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
        color: "#202223",
      }}
    >
      <header style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 13, color: "#6d7175", fontWeight: 700 }}>
          INTERNAL · AI-BUYNSE
        </div>
        <h1 style={{ margin: "4px 0 6px", fontSize: 30 }}>Dev Dashboard</h1>
        <p style={{ margin: 0, color: "#6d7175" }}>
          Provider capacity, token/cost telemetry, shop plans, effective quotas,
          support grants and audit history. Generated {fmtDate(data.generatedAt)}.
        </p>
      </header>

      {actionData ? (
        <div
          style={{
            ...cardStyle,
            marginBottom: 16,
            borderColor: actionData.ok ? "#8ccf9b" : "#e0a1a1",
            background: actionData.ok ? "#f1f8f3" : "#fff4f4",
          }}
        >
          {actionData.message}
        </div>
      ) : null}

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
          gap: 12,
          marginBottom: 20,
        }}
      >
        <div style={cardStyle}>
          <small>OpenAI cost MTD · estimated</small>
          <div style={{ fontSize: 25, fontWeight: 800 }}>
            {fmtUsd(data.provider.totalCostUsd)}
          </div>
          <div style={{ color: "#6d7175", fontSize: 13 }}>
            Search {fmtUsd(data.provider.searchCostUsd)} · Indexing{" "}
            {fmtUsd(data.provider.indexingCostUsd)}
          </div>
        </div>
        <div style={cardStyle}>
          <small>Internal API budget remaining</small>
          <div style={{ fontSize: 25, fontWeight: 800 }}>
            {fmtUsd(data.provider.remainingBudgetUsd)}
          </div>
          <div style={{ color: "#6d7175", fontSize: 13 }}>
            Budget {fmtUsd(data.provider.configuredBudgetUsd)}
          </div>
        </div>
        <div style={cardStyle}>
          <small>Latest rate-limit tokens</small>
          <div style={{ fontSize: 25, fontWeight: 800 }}>
            {data.provider.latestRate?.remainingTokens?.toLocaleString() ?? "—"}
          </div>
          <div style={{ color: "#6d7175", fontSize: 13 }}>
            Requests {data.provider.latestRate?.remainingRequests ?? "—"} · reset{" "}
            {data.provider.latestRate?.resetTokens ?? "—"}
          </div>
        </div>
        <div style={cardStyle}>
          <small>Tokens MTD</small>
          <div style={{ fontSize: 25, fontWeight: 800 }}>
            {data.provider.totalTokens.toLocaleString()}
          </div>
          <div style={{ color: "#6d7175", fontSize: 13 }}>
            LLM {data.provider.llmTokens.toLocaleString()} · Embedding{" "}
            {data.provider.embeddingTokens.toLocaleString()}
          </div>
        </div>
        <div style={cardStyle}>
          <small>AI searches MTD</small>
          <div style={{ fontSize: 25, fontWeight: 800 }}>
            {data.provider.mtdSearches.toLocaleString()}
          </div>
          <div style={{ color: "#6d7175", fontSize: 13 }}>
            Avg search cost {fmtUsd(data.provider.avgSearchCostUsd)}
          </div>
        </div>
        <div style={cardStyle}>
          <small>Estimated searches remaining</small>
          <div style={{ fontSize: 25, fontWeight: 800 }}>
            {data.provider.estimatedSearchesRemaining?.toLocaleString() ?? "—"}
          </div>
          <div style={{ color: "#6d7175", fontSize: 13 }}>
            Based on configured budget + current average
          </div>
        </div>
      </section>

      <section style={{ ...cardStyle, marginBottom: 20 }}>
        <Form method="get" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            name="q"
            defaultValue={data.query}
            placeholder="Search shop domain..."
            style={{
              flex: 1,
              minWidth: 260,
              padding: "9px 11px",
              border: "1px solid #c9cccf",
              borderRadius: 8,
            }}
          />
          <button type="submit" style={{ padding: "9px 14px" }}>
            Search
          </button>
        </Form>
      </section>

      <section style={{ ...cardStyle, overflowX: "auto", marginBottom: 20 }}>
        <h2 style={{ marginTop: 0 }}>Shop management ({data.shops.length})</h2>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            minWidth: 1250,
            fontSize: 13,
          }}
        >
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #dfe3e8" }}>
              <th style={{ padding: 8 }}>Shop</th>
              <th>Plan</th>
              <th>AI</th>
              <th>Products</th>
              <th>Search</th>
              <th>Vector updates</th>
              <th>API tokens MTD</th>
              <th>API cost MTD</th>
              <th>Support</th>
            </tr>
          </thead>
          <tbody>
            {data.shops.map((shop) => (
              <tr key={shop.shop} style={{ borderBottom: "1px solid #eef0f2" }}>
                <td style={{ padding: 8, verticalAlign: "top" }}>
                  <strong>{shop.shop}</strong>
                  <div style={{ color: "#6d7175" }}>
                    {shop.lifecycleStatus} · {shop.subscriptionStatus}
                  </div>
                  <div style={{ color: "#6d7175" }}>
                    cycle ends {fmtDate(shop.billingPeriodEnd)}
                  </div>
                </td>
                <td style={{ verticalAlign: "top" }}>
                  <strong>{shop.planLabel}</strong>
                  <div>{shop.plan}</div>
                </td>
                <td style={{ verticalAlign: "top" }}>
                  {shop.aiSearchEnabled ? "ON" : "OFF"}
                </td>
                <td style={{ verticalAlign: "top" }}>
                  {progress(shop.usage.indexedProducts, shop.limits.productLimit)}
                  {shop.grants.product ? (
                    <div>grant +{shop.grants.product.toLocaleString()}</div>
                  ) : null}
                </td>
                <td style={{ verticalAlign: "top" }}>
                  {progress(shop.usage.searchCount, shop.limits.searchLimit)}
                  {shop.grants.search ? (
                    <div>grant +{shop.grants.search.toLocaleString()}</div>
                  ) : null}
                </td>
                <td style={{ verticalAlign: "top" }}>
                  {progress(
                    shop.usage.vectorUpdateCount,
                    shop.limits.vectorUpdateLimit,
                  )}
                  {shop.grants.vectorUpdate ? (
                    <div>grant +{shop.grants.vectorUpdate.toLocaleString()}</div>
                  ) : null}
                </td>
                <td style={{ verticalAlign: "top" }}>
                  {shop.api.totalTokens.toLocaleString()}
                  <div style={{ color: "#6d7175" }}>
                    in {shop.api.inputTokens.toLocaleString()} · out{" "}
                    {shop.api.outputTokens.toLocaleString()}
                  </div>
                </td>
                <td style={{ verticalAlign: "top" }}>
                  ${shop.api.costUsd.toFixed(4)}
                </td>
                <td style={{ verticalAlign: "top", minWidth: 330 }}>
                  <details>
                    <summary style={{ cursor: "pointer", fontWeight: 700 }}>
                      Adjust
                    </summary>

                    <Form method="post" style={{ marginTop: 10 }}>
                      <input type="hidden" name="intent" value="grant_quota" />
                      <input type="hidden" name="targetShop" value={shop.shop} />
                      <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                        <select name="kind" defaultValue="SEARCH">
                          <option value="SEARCH">Searches</option>
                          <option value="VECTOR_UPDATE">Vector updates</option>
                          <option value="PRODUCT">Products</option>
                        </select>
                        <input
                          name="amount"
                          type="number"
                          min="1"
                          placeholder="+ amount"
                          required
                          style={{ width: 105 }}
                        />
                        <select name="expiryMode" defaultValue="BILLING_CYCLE">
                          <option value="BILLING_CYCLE">End billing cycle</option>
                          <option value="30_DAYS">30 days</option>
                          <option value="NEVER">No expiry</option>
                        </select>
                      </div>
                      <input
                        name="reason"
                        placeholder="Support reason / ticket"
                        required
                        style={{ width: "100%", marginBottom: 6 }}
                      />
                      <button disabled={busy} type="submit">
                        Add grant
                      </button>
                    </Form>

                    <hr style={{ border: 0, borderTop: "1px solid #eee" }} />

                    <Form method="post">
                      <input type="hidden" name="intent" value="set_limits" />
                      <input type="hidden" name="targetShop" value={shop.shop} />
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 5 }}>
                        <input
                          name="productLimitOverride"
                          type="number"
                          min="0"
                          placeholder="Product absolute limit"
                          defaultValue={shop.overrides.product ?? ""}
                        />
                        <input
                          name="searchLimitOverride"
                          type="number"
                          min="0"
                          placeholder="Search absolute limit"
                          defaultValue={shop.overrides.search ?? ""}
                        />
                        <input
                          name="vectorUpdateLimitOverride"
                          type="number"
                          min="0"
                          placeholder="Vector absolute limit"
                          defaultValue={shop.overrides.vectorUpdate ?? ""}
                        />
                      </div>
                      <input
                        name="reason"
                        placeholder="Reason (blank limits = return to plan defaults)"
                        required
                        style={{ width: "100%", margin: "6px 0" }}
                      />
                      <button disabled={busy} type="submit">
                        Set absolute overrides
                      </button>
                    </Form>

                    <hr style={{ border: 0, borderTop: "1px solid #eee" }} />

                    <Form method="post">
                      <input type="hidden" name="intent" value="toggle_ai" />
                      <input type="hidden" name="targetShop" value={shop.shop} />
                      <input
                        type="hidden"
                        name="enabled"
                        value={shop.aiSearchEnabled ? "false" : "true"}
                      />
                      <input
                        name="reason"
                        placeholder="Reason for kill-switch change"
                        required
                        style={{ width: "100%", marginBottom: 6 }}
                      />
                      <button disabled={busy} type="submit">
                        {shop.aiSearchEnabled ? "Disable AI Search" : "Enable AI Search"}
                      </button>
                    </Form>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))",
          gap: 16,
        }}
      >
        <div style={cardStyle}>
          <h2 style={{ marginTop: 0 }}>Recent quota grants</h2>
          {data.recentGrants.map((grant) => (
            <div
              key={grant.id}
              style={{ padding: "10px 0", borderBottom: "1px solid #eef0f2" }}
            >
              <strong>{grant.shop}</strong> · {grant.kind} +{grant.amount}
              <div style={{ color: "#6d7175" }}>
                {grant.reason || "No reason"} · expires {fmtDate(grant.expiresAt)}
                {grant.revokedAt ? ` · revoked ${fmtDate(grant.revokedAt)}` : ""}
              </div>
              {!grant.revokedAt ? (
                <Form method="post" style={{ marginTop: 5 }}>
                  <input type="hidden" name="intent" value="revoke_grant" />
                  <input type="hidden" name="grantId" value={grant.id} />
                  <input
                    name="reason"
                    placeholder="Reason to revoke"
                    required
                    style={{ marginRight: 6 }}
                  />
                  <button disabled={busy} type="submit">
                    Revoke
                  </button>
                </Form>
              ) : null}
            </div>
          ))}
        </div>

        <div style={cardStyle}>
          <h2 style={{ marginTop: 0 }}>Admin audit</h2>
          {data.recentAudit.map((item) => (
            <div
              key={item.id}
              style={{ padding: "10px 0", borderBottom: "1px solid #eef0f2" }}
            >
              <strong>{item.action}</strong> · {item.targetShop}
              <div style={{ color: "#6d7175" }}>
                by {item.actorShop} · {fmtDate(item.createdAt)}
              </div>
              <div>{item.reason || "—"}</div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
