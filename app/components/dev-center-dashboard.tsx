import { useState, type ReactNode } from "react";
import { Form, Link, useNavigation } from "react-router";

import type { DevDashboardData } from "../services/admin/dev-dashboard.server";
type DevRole = "OWNER" | "ADMIN" | "VIEWER";
type UiWritePermission =
  | "shop_quota.write"
  | "shop_plan.write"
  | "system.write";

function hasDevPermission(role: DevRole, permission: UiWritePermission) {
  if (role === "OWNER") return true;
  if (role === "ADMIN") return permission !== "system.write";
  return false;
}

type Feedback = { ok: boolean; message: string } | undefined;
type Shop = DevDashboardData["shops"][number];
type Grant = DevDashboardData["supportGrants"][number];
type PlanCatalogItem = DevDashboardData["planCatalog"][number];
type Tone = "success" | "warning" | "danger" | "neutral" | "primary";

const PLAN_CAPABILITIES = [
  ["semanticSearch", "Semantic search"],
  ["multilingualSearch", "Multilingual query translation"],
  ["searchAnalytics", "Search analytics"],
  ["themeIntegration", "Theme Map integration"],
  ["selfRendering", "Self-rendering storefront mode"],
  ["customDataMode", "Custom data mode"],
] as const;

export function DevCenterDashboard({
  data,
  devUser,
  csrfToken,
  grantRequestId,
  managedShop,
  feedback,
}: {
  data: DevDashboardData;
  devUser: { email: string; role: DevRole };
  csrfToken: string;
  grantRequestId: string;
  managedShop: string | null;
  feedback: Feedback;
}) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const selectedShop = managedShop
    ? data.shops.find((shop) => shop.shop === managedShop) ?? null
    : null;
  const selectedGrants = selectedShop
    ? data.supportGrants.filter(
        (grant) => grant.shop === selectedShop.shop && grant.active,
      )
    : [];
  const canQuotaWrite = hasDevPermission(devUser.role, "shop_quota.write");
  const canPlanWrite = hasDevPermission(devUser.role, "shop_plan.write");
  const canSystemWrite = hasDevPermission(devUser.role, "system.write");
  const usdMrr =
    data.financial.revenue.find((item) => item.currency === "USD")?.mrr ?? null;
  const estimatedMargin =
    usdMrr === null || data.provider.unknownCostRequests > 0 ? null : usdMrr - data.provider.totalCostUsd;

  return (
    <div className="dc-shell">
      {busy ? (
        <DevLoader
          label={navigation.state === "submitting" ? "Saving changes..." : "Loading Dev Center..."}
        />
      ) : null}
      <aside className="dc-sidebar">
        <div className="dc-brand">
          <span className="dc-brand-mark">B</span>
          <span>
            <strong>AI-Buyense</strong>
            <small>Internal Dev Center</small>
          </span>
        </div>

        <nav className="dc-nav" aria-label="Dev Center navigation">
          <NavItem href="#overview" label="Overview" icon="01" />
          <NavItem href="#shops" label="Shops" icon="02" />
          <Link to="/dev/search-history"><span>03</span>Search History</Link>
          <Link to="/dev/plan-configuration"><span>04</span>Plan Configuration</Link>
          <NavItem href="#plans" label="Revenue" icon="05" />
          <NavItem href="#usage" label="Usage & Cost" icon="06" />
          <NavItem href="#audit" label="Audit" icon="07" />
        </nav>

        <div className="dc-sidebar-meta">
          <span className="dc-system-dot" />
          <div>
            <strong>Internal access</strong>
            <small>MFA protected session</small>
          </div>
        </div>
      </aside>

      <main className="dc-main">
        <header className="dc-header">
          <div>
            <p className="dc-kicker">Application operations</p>
            <h1>Dev Center</h1>
            <p className="dc-header-sub">
              Business health, merchant operations and commercial controls.
            </p>
          </div>
          <div className="dc-user">
            <span className="dc-avatar">{devUser.email.slice(0, 1).toUpperCase()}</span>
            <div>
              <strong>{devUser.email}</strong>
              <small>{devUser.role}</small>
            </div>
            <Form method="post" action="/dev/logout">
              <input type="hidden" name="_csrf" value={csrfToken} />
              <button className="dc-button dc-button-ghost" type="submit">
                Sign out
              </button>
            </Form>
          </div>
        </header>

        {feedback ? (
          <div className={`dc-alert ${feedback.ok ? "is-success" : "is-error"}`}>
            {feedback.message}
          </div>
        ) : null}

        <section id="overview" className="dc-section">
          {data.shopCoverage.partial ? <p role="status">Shop table is limited to the latest {data.shopCoverage.displayed} of {data.shopCoverage.total} shops. Shop/product totals and usage sums are global; AI-enabled count is limited to displayed shops.</p> : null}
          <SectionHeader
            eyebrow="Overview"
            title="Business at a glance"
            note={`Live application data · updated ${formatDate(data.generatedAt)}`}
          />
          <div className="dc-kpi-grid">
            <Metric label="Total shops" value={number(data.overview.totalShops)} note={`${number(data.overview.activeShops)} lifecycle active`} />
            <Metric label="Paid shops" value={number(data.overview.paidShops)} note={`${number(data.financial.trialSubscriptions)} currently in trial`} tone="success" />
            <Metric label="AI enabled" value={number(data.overview.aiEnabledShops)} note="Active entitlement and toggle on" />
            <Metric label="Subscription MRR" value={moneyList(data.financial.revenue)} note="Active Billing V2 snapshots" tone="primary" />
            <Metric label="Estimated API cost MTD" value={data.provider.unknownCostRequests > 0 ? "Incomplete" : usd(data.provider.totalCostUsd)} note={`${data.provider.unknownCostRequests} requests have unknown model rates. Known-rate subtotal: ${usd(data.provider.totalCostUsd)}. Not a provider invoice.`} />
            <Metric label="Estimated margin" value={estimatedMargin === null ? "—" : usd(estimatedMargin)} note={usdMrr === null ? "Requires comparable USD MRR" : "USD MRR minus provider cost"} />
            <Metric label="AI searches MTD" value={number(data.overview.searchesMtd)} note={`${usdNullable(data.provider.avgSearchCostUsd)} average cost/search`} />
            <Metric label="Stored vectors" value={number(data.overview.indexedProducts)} note="Retained vectors across all shops, including inactive products" />
          </div>
        </section>

        <section id="shops" className="dc-section">
          <SectionHeader
            eyebrow="Merchants"
            title="Shop operations"
            note="Commercial state and usable capacity are derived from Billing V2."
            action={
              <Form method="get" className="dc-search">
                <input name="q" defaultValue={data.query} placeholder="Search shop domain" aria-label="Search shop domain" />
                <button className="dc-button" type="submit">Search</button>
              </Form>
            }
          />
          <div className="dc-table-panel">
            <div className="dc-table-scroll">
              <table className="dc-table dc-shop-table">
                <thead>
                  <tr>
                    <th>Shop</th>
                    <th>Lifecycle</th>
                    <th>Subscription</th>
                    <th>Plan & price</th>
                    <th>AI state</th>
                    <th>Products</th>
                    <th>Searches</th>
                    <th>Vector updates</th>
                    <th>API cost MTD</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.shops.map((shop) => (
                    <tr key={shop.shop}>
                      <td>
                        <strong className="dc-shop-name">{shop.shop}</strong>
                        <small>Cycle ends {formatDate(shop.commercial.periodEnd)}</small>
                      </td>
                      <td><StatusBadge tone={lifecycleTone(shop.lifecycleStatus)}>{shop.lifecycleStatus}</StatusBadge></td>
                      <td><StatusBadge tone={subscriptionTone(shop.subscriptionStatus)}>{shop.subscriptionStatus}</StatusBadge></td>
                      <td>
                        <strong>{shop.commercial.planLabel}</strong>
                        <small>
                          {shop.legacySource === "DEV_OVERRIDE" &&
                          shop.subscriptionStatus === "ACTIVE"
                            ? "Dev override · no Shopify billing"
                            : commercialPrice(shop)}
                        </small>
                        {shop.pendingPlanHandle ? (
                          <em className="dc-pending">
                            Pending plan: {shop.pendingPlanHandle.toLowerCase() === "custom"
                              ? shop.customConfig?.name ?? "Custom"
                              : shop.pendingPlanHandle}
                          </em>
                        ) : shop.commercial.customTerms?.pendingCommercialChange ? (
                          <em className="dc-pending">Pending commercial change</em>
                        ) : null}
                      </td>
                      <td>
                        <StatusBadge tone={shop.state.aiOperational ? "success" : shop.state.aiConfigured ? "warning" : "danger"}>
                          {shop.state.aiOperational ? "Operational" : shop.state.aiConfigured ? "Not entitled" : "Disabled"}
                        </StatusBadge>
                      </td>
                      <td><QuotaCell quota={shop.quota.products} active={shop.subscriptionStatus === "ACTIVE"} /></td>
                      <td><QuotaCell quota={shop.quota.searches} active={shop.subscriptionStatus === "ACTIVE"} /></td>
                      <td><QuotaCell quota={shop.quota.vectorUpdates} active={shop.subscriptionStatus === "ACTIVE"} /></td>
                      <td><strong>{shop.cost.unknownCostRequests > 0 ? "Incomplete" : usd(shop.cost.mtdUsd)}</strong></td>
                      <td>
                        <Link className="dc-button dc-button-compact" to={manageUrl(data.query, shop.shop)}>
                          Manage
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.shops.length === 0 ? <Empty>No shops match this filter.</Empty> : null}
          </div>
        </section>


        <section id="plans" className="dc-section">
          <SectionHeader
            eyebrow="Commercial"
            title="Revenue"
            note="Subscription MRR is run-rate from ACTIVE BillingSubscription.priceSnapshot values, not Shopify payout or cash received."
          />
          <div className="dc-two-column">
            <div className="dc-panel dc-panel-flush">
              <div className="dc-panel-head">
                <div><strong>Plan distribution</strong><small>Current Billing V2 state</small></div>
                <div className="dc-mrr-summary"><small>Total MRR</small><strong>{moneyList(data.financial.revenue)}</strong></div>
              </div>
              <div className="dc-table-scroll">
                <table className="dc-table">
                  <thead><tr><th>Plan</th><th>Active</th><th>Trial</th><th>Frozen</th><th>MRR</th></tr></thead>
                  <tbody>
                    {data.financial.plans.map((plan) => (
                      <tr key={plan.key}>
                        <td><strong>{plan.name}</strong><small>{plan.key === "CUSTOM" ? "Shop-specific terms" : plan.handle}</small></td>
                        <td>{number(plan.active)}</td>
                        <td>{number(plan.trials)}</td>
                        <td>{number(plan.frozen)}</td>
                        <td>{plan.revenue.length ? plan.revenue.map((item) => formatMoney(item.mrr, item.currency)).join(" · ") : "—"}</td>
                      </tr>
                    ))}
                    <tr>
                      <td><strong>No active plan</strong><small>Inactive, cancelled or not established</small></td>
                      <td>{number(data.financial.shopsWithoutActiveSubscription)}</td><td>—</td><td>—</td><td>—</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
            <div className="dc-panel">
              <p className="dc-panel-label">Revenue definition</p>
              <h3>Subscription run-rate</h3>
              <p className="dc-copy">Monthly subscriptions contribute their active price snapshot. Annual subscriptions contribute one twelfth of their snapshot. Currencies are never combined.</p>
              <div className="dc-stat-list">
                <Stat label="Active paid subscriptions" value={number(data.financial.activeSubscriptions)} />
                <Stat label="Frozen subscriptions" value={number(data.financial.frozenSubscriptions)} />
                <Stat label="Cancelled / expired" value={number(data.financial.cancelledSubscriptions)} />
                <Stat label="ARR (secondary)" value={data.financial.revenue.length ? data.financial.revenue.map((item) => formatMoney(item.arr, item.currency)).join(" · ") : "—"} />
              </div>
              <div className="dc-info-note">Actual Shopify payouts, transaction fees and net cash are unavailable until Partner transaction sync is implemented.</div>
            </div>
          </div>
        </section>

        <section id="usage" className="dc-section">
          <SectionHeader eyebrow="Economics" title="Usage & cost" note={`Month to date from ${new Date(data.monthStart).toLocaleDateString()}.`} />
          <div className="dc-three-column">
            <UsageCard label="Search operations" value={number(data.provider.mtdSearches)} cost={data.provider.unknownCostRequests > 0 ? "Incomplete" : usd(data.provider.searchCostUsd)} detail="Query analysis and query embeddings" />
            <UsageCard label="Stored vector footprint" value={number(data.overview.indexedProducts)} cost={data.provider.unknownCostRequests > 0 ? "Incomplete" : usd(data.provider.indexingCostUsd)} detail="MTD enrichment/embedding cost; stored vector count is not monthly usage" />
            <UsageCard label="Total provider usage" value={number(data.provider.totalTokens)} cost={data.provider.unknownCostRequests > 0 ? "Incomplete" : usd(data.provider.totalCostUsd)} detail="Recorded tokens and configured estimates; never provider invoice costs" />
          </div>
          <details className="dc-diagnostics">
            <summary>Advanced diagnostics</summary>
            <div className="dc-diagnostic-grid">
              <Stat label="Input tokens" value={number(data.provider.inputTokens)} />
              <Stat label="Output tokens" value={number(data.provider.outputTokens)} />
              <Stat label="Embedding tokens" value={number(data.provider.embeddingTokens)} />
              <Stat label="LLM tokens" value={number(data.provider.llmTokens)} />
              <Stat label="Configured budget" value={usdNullable(data.provider.configuredBudgetUsd)} />
              <Stat label="Remaining budget" value={usdNullable(data.provider.remainingBudgetUsd)} />
              <Stat label="Failed sync jobs" value={number(data.diagnostics.failedSyncJobs)} />
              <Stat label="Readiness (measured dependencies)" value={data.readiness.status} />
              <Stat label="Recorded proxy requests MTD" value={number(data.attemptMetrics.proxyRequests)} />
              <Stat label="Search requests MTD" value={number(data.attemptMetrics.searchRequests)} />
              <Stat label="Pipeline executions (excludes full-result cache)" value={number(data.attemptMetrics.pipelineExecutions)} />
              <Stat label="Full-result cache hits" value={number(data.attemptMetrics.cacheHits)} />
              <Stat label="Native fallbacks (excluded from AI CTR)" value={number(data.attemptMetrics.nativeFallbacks)} />
              <Stat label="Searches with products" value={number(data.attemptMetrics.searchesWithResults)} />
              <Stat label="Incomplete attempts (not assumed zero)" value={number(data.attemptMetrics.incompleteAttempts)} />
              <Stat label="Attempt telemetry since" value={data.attemptMetrics.recordedSince ?? "Not yet recorded"} />
              {Object.entries(data.readiness.checks).map(([name, status]) => <Stat key={name} label={name} value={status} />)}
              <Stat label="Failed catalog jobs" value={number(data.diagnostics.failedCatalogJobs)} />
              <Stat label="Active subscriptions missing price" value={number(data.diagnostics.activeSubscriptionsMissingPrice)} />
            </div>
          </details>
        </section>

        <section id="audit" className="dc-section">
          <SectionHeader eyebrow="Accountability" title="Audit history" note="Commercial/support activity and security events are intentionally separated." />
          <div className="dc-two-column">
            <AuditPanel title="Support & commercial changes" empty="No support activity yet.">
              {data.recentAudit.slice(0, 12).map((event) => <BusinessAudit key={event.id} event={event} />)}
            </AuditPanel>
            <AuditPanel title="Security activity" empty="No security activity yet.">
              {data.securityAudit.filter((event) => /LOGIN|PASSWORD|MFA|LOGOUT|AUTH/.test(event.action)).slice(0, 12).map((event) => (
                <div className="dc-audit-row" key={event.id}>
                  <div><strong>{securityLabel(event.action)}</strong><small>{event.userEmail ?? "Unknown user"} · {formatDate(event.createdAt)}</small></div>
                  <StatusBadge tone={event.result === "SUCCESS" ? "success" : "warning"}>{event.result}</StatusBadge>
                </div>
              ))}
            </AuditPanel>
          </div>
        </section>
      </main>

      {selectedShop ? (
        <ShopDrawer
          shop={selectedShop}
          grants={selectedGrants}
          csrfToken={csrfToken}
          grantRequestId={grantRequestId}
          query={data.query}
          canQuotaWrite={canQuotaWrite}
          canPlanWrite={canPlanWrite}
          canSystemWrite={canSystemWrite}
          busy={busy}
        />
      ) : null}
    </div>
  );
}

export function PlanCatalogEditor({ plans, csrfToken, canWrite, busy }: {
  plans: PlanCatalogItem[];
  csrfToken: string;
  canWrite: boolean;
  busy: boolean;
}) {
  const merchantFeatureCatalog = Array.from(
    new Map(
      plans
        .flatMap((plan) => plan.features.merchantFeatures ?? [])
        .map((feature) => [
          feature.key,
          { key: feature.key, label: feature.label },
        ]),
    ).values(),
  );

  return (
    <div className="dc-panel" style={{ marginTop: 18 }}>
      <div className="dc-panel-head">
        <div>
          <strong>Plan configuration</strong>
          <small>Create plans and control price, capacity and included capabilities.</small>
        </div>
        <StatusBadge tone="neutral">{plans.length} plans</StatusBadge>
      </div>
      <div className="dc-info-note">
        Quota and capability edits change entitlement for current subscribers immediately. Price changes apply to new purchases or plan changes. Only Basic offers an introductory free trial. Money-back days and refund terms are captured for new purchases, not applied retroactively. For Shopify App Pricing, configure the trial in Shopify's pricing dashboard as well.
      </div>

      {canWrite ? (
        <details className="dc-advanced" open>
          <summary>Create new plan</summary>
          <PlanEditorForm
            csrfToken={csrfToken}
            busy={busy}
            merchantFeatureCatalog={merchantFeatureCatalog}
          />
        </details>
      ) : <ReadOnly />}

      <div style={{ display: "grid", gap: 12, marginTop: 14 }}>
        {plans.map((plan) => (
          <details className="dc-advanced" key={plan.id}>
            <summary>
              {plan.name} · {formatMoney(plan.price, plan.currencyCode)}
              {plan.interval === "ANNUAL" ? " / year" : " / month"} · {plan.isActive ? "Active" : "Inactive"}
            </summary>
            <div className="dc-detail-grid" style={{ marginBottom: 12 }}>
              <Stat label="Handle" value={plan.handle} />
              <Stat label="Visibility" value={plan.visibility} />
              <Stat label="Active subscriptions" value={number(plan.subscriptions.active)} />
              <Stat label="Version" value={String(plan.version)} />
            </div>
            {canWrite ? (
              <>
                <PlanEditorForm
                  plan={plan}
                  csrfToken={csrfToken}
                  busy={busy}
                  merchantFeatureCatalog={merchantFeatureCatalog}
                />
                <Form
                  method="post"
                  style={{ marginTop: 10 }}
                  onSubmit={(event) => {
                    if (!window.confirm(`Delete plan "${plan.name}"? Plans with subscription or assignment history cannot be hard-deleted.`)) {
                      event.preventDefault();
                    }
                  }}
                >
                  <input type="hidden" name="_csrf" value={csrfToken} />
                  <input type="hidden" name="intent" value="delete_plan" />
                  <input type="hidden" name="planId" value={plan.id} />
                  <button className="dc-link-danger" disabled={busy} type="submit">
                    Delete plan
                  </button>
                </Form>
              </>
            ) : (
              <div className="dc-stat-list">
                <Stat label="Products" value={planLimit(plan.limits.productLimit)} />
                <Stat label="Searches / month" value={planLimit(plan.limits.searchLimit)} />
                <Stat label="Vector updates / month" value={planLimit(plan.limits.vectorUpdateLimit)} />
              </div>
            )}
          </details>
        ))}
      </div>
    </div>
  );
}

function PlanEditorForm({
  plan,
  csrfToken,
  busy,
  merchantFeatureCatalog,
}: {
  plan?: PlanCatalogItem;
  csrfToken: string;
  busy: boolean;
  merchantFeatureCatalog: Array<{ key: string; label: string }>;
}) {
  const isNew = !plan;
  const [merchantFeatures, setMerchantFeatures] = useState(() => {
    const planFeatures = new Map(
      (plan?.features.merchantFeatures ?? []).map((feature) => [
        feature.key,
        feature,
      ]),
    );
    const shared = merchantFeatureCatalog.map((feature) => {
      const configured = planFeatures.get(feature.key);
      return configured
        ? {
            key: feature.key,
            label: configured.label || feature.label,
            included: configured.included,
          }
        : { ...feature, included: false };
    });
    const sharedKeys = new Set(merchantFeatureCatalog.map((feature) => feature.key));
    const planOnly = (plan?.features.merchantFeatures ?? []).filter(
      (feature) => !sharedKeys.has(feature.key),
    );
    return [...shared, ...planOnly];
  });

  const addMerchantFeature = () => {
    const key = `feature-${Date.now()}-${merchantFeatures.length + 1}`;
    setMerchantFeatures((current) => [
      ...current,
      { key, label: "", included: true },
    ]);
  };

  return (
    <Form method="post" className="dc-form-card" style={{ marginTop: 12 }}>
      <input type="hidden" name="_csrf" value={csrfToken} />
      <input type="hidden" name="intent" value={isNew ? "create_plan" : "update_plan"} />
      {plan ? <input type="hidden" name="planId" value={plan.id} /> : null}

      <div className="dc-form-grid-3">
        <Field label="Plan name">
          <input name="planName" required defaultValue={plan?.name ?? ""} placeholder="Growth" />
        </Field>
        <Field label="Handle">
          <input name="planHandle" required readOnly={!isNew} defaultValue={plan?.handle ?? ""} placeholder="growth" />
        </Field>
        <Field label="Sort order">
          <input name="planSortOrder" type="number" defaultValue={plan?.sortOrder ?? 30} />
        </Field>
      </div>

      <Field label="Description">
        <textarea name="planDescription" rows={2} defaultValue={plan?.features.description ?? ""} placeholder="Who this plan is for and its main value." />
      </Field>

      <div className="dc-form-grid-3">
        <Field label="Price">
          <input name="planPrice" type="number" min="0" step="0.01" required defaultValue={plan?.price ?? 0} />
        </Field>
        <Field label="Currency">
          <input name="planCurrency" maxLength={3} required defaultValue={plan?.currencyCode ?? "USD"} />
        </Field>
        <Field label="Billing interval">
          <select name="planInterval" defaultValue={plan?.interval ?? "EVERY_30_DAYS"}>
            <option value="EVERY_30_DAYS">Every 30 days</option>
            <option value="ANNUAL">Annual</option>
          </select>
        </Field>
        <Field label="Free trial days (Basic only)">
          <input name="planTrialDays" type="number" min="0" max="365" step="1" readOnly={Boolean(plan && plan.handle !== "basic")} defaultValue={plan?.handle === "basic" ? plan.trialDays : 0} />
        </Field>
        <Field label="Money-back guarantee days (0 = disabled)">
          <input name="planMoneyBackDays" type="number" min="0" max="365" step="1" defaultValue={plan?.features.billingPolicy.moneyBackGuaranteeDays ?? 0} />
        </Field>
        <Field label="Refund terms (required when enabled)">
          <textarea name="planRefundTerms" maxLength={2000} rows={3} defaultValue={plan?.features.billingPolicy.refundTerms ?? ""} placeholder="Eligibility, exclusions, first payment or renewals, and how to contact support. The window starts after verified payment, not installation." />
        </Field>
        <Field label="Visibility">
          <select name="planVisibility" defaultValue={plan?.visibility ?? "PUBLIC"}>
            <option value="PUBLIC">Public</option>
            <option value="PRIVATE">Private</option>
            <option value="INTERNAL">Internal</option>
          </select>
        </Field>
        <Field label="Billing mode">
          <select name="planBillingMode" defaultValue={plan?.billingMode ?? "MANUAL_BILLING"}>
            <option value="MANUAL_BILLING">Shopify Billing API</option>
            <option value="SHOPIFY_APP_PRICING">Shopify managed pricing</option>
          </select>
        </Field>
      </div>

      <div className="dc-form-grid-3">
        <Field label="Indexed products">
          <input name="planProductLimit" type="number" min="0" defaultValue={plan?.limits.productLimit ?? ""} placeholder="Blank = unlimited" />
        </Field>
        <Field label="Searches / month">
          <input name="planSearchLimit" type="number" min="0" defaultValue={plan?.limits.searchLimit ?? ""} placeholder="Blank = unlimited" />
        </Field>
        <Field label="Vector updates / month">
          <input name="planVectorLimit" type="number" min="0" defaultValue={plan?.limits.vectorUpdateLimit ?? ""} placeholder="Blank = unlimited" />
        </Field>
      </div>

      <div>
        <strong style={{ display: "block", fontSize: 13, marginBottom: 8 }}>Included capabilities</strong>
        <div className="dc-form-grid-3">
          {PLAN_CAPABILITIES.map(([key, label]) => (
            <label key={key} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
              <input
                type="checkbox"
                name="planCapability"
                value={key}
                defaultChecked={plan ? plan.features.capabilities[key] : key !== "customDataMode"}
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      <div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 8 }}>
          <strong style={{ fontSize: 13 }}>Merchant-facing feature rows</strong>
          <button className="dc-button dc-button-ghost" type="button" onClick={addMerchantFeature}>
            Add feature
          </button>
        </div>
        <div style={{ display: "grid", gap: 8 }}>
          {merchantFeatures.map((feature, index) => (
            <div
              key={feature.key}
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) auto auto",
                gap: 10,
                alignItems: "center",
              }}
            >
              <input type="hidden" name="planFeatureKey" value={feature.key} />
              <input
                name="planFeatureLabel"
                required
                value={feature.label}
                placeholder="e.g. Priority indexing"
                onChange={(event) => {
                  const label = event.target.value;
                  setMerchantFeatures((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, label } : item,
                    ),
                  );
                }}
              />
              <label
                style={{
                  display: "flex",
                  gap: 6,
                  alignItems: "center",
                  fontSize: 12,
                  color: feature.included ? "#067647" : "#b42318",
                  fontWeight: 700,
                }}
              >
                <input
                  type="checkbox"
                  name="planFeatureIncluded"
                  value={feature.key}
                  checked={feature.included}
                  onChange={(event) => {
                    const included = event.target.checked;
                    setMerchantFeatures((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, included } : item,
                      ),
                    );
                  }}
                />
                {feature.included ? "✓ Included" : "× Not included"}
              </label>
              <button
                className="dc-link-danger"
                type="button"
                onClick={() =>
                  setMerchantFeatures((current) =>
                    current.filter((_, itemIndex) => itemIndex !== index),
                  )
                }
              >
                Remove
              </button>
            </div>
          ))}
          {merchantFeatures.length === 0 ? (
            <small style={{ color: "#6b7280" }}>
              No custom comparison features yet. Add rows to show them across all merchant plan cards.
            </small>
          ) : null}
        </div>
      </div>

      <Field label="Merchant-facing highlights (one per line)">
        <textarea name="planHighlights" rows={4} defaultValue={plan?.features.highlights.join("\n") ?? ""} placeholder={"Priority indexing\nAdvanced analytics\nEmail support"} />
      </Field>

      <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
          <input type="checkbox" name="planUsageBillingEnabled" defaultChecked={plan?.usageBillingEnabled ?? false} /> Usage billing enabled
        </label>
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
          <input type="checkbox" name="planIsActive" defaultChecked={plan?.isActive ?? true} /> Active / purchasable
        </label>
      </div>

      <Field label="Change note (optional)">
        <input name="reason" placeholder={isNew ? "Optional note about this plan" : "Optional note about this change"} />
      </Field>
      <button className="dc-button dc-button-primary" disabled={busy} type="submit">
        {busy ? "Saving..." : isNew ? "Create plan" : "Save plan"}
      </button>
    </Form>
  );
}

function planLimit(value: number | null) {
  return value === null ? "Unlimited" : number(value);
}

function ShopDrawer({ shop, grants, csrfToken, grantRequestId, query, canQuotaWrite, canPlanWrite, canSystemWrite, busy }: {
  shop: Shop;
  grants: Grant[];
  csrfToken: string;
  grantRequestId: string;
  query: string;
  canQuotaWrite: boolean;
  canPlanWrite: boolean;
  canSystemWrite: boolean;
  busy: boolean;
}) {
  return (
    <div className="dc-drawer-layer" role="dialog" aria-modal="true" aria-labelledby="shop-drawer-title">
      <Link className="dc-drawer-backdrop" to={closeManageUrl(query)} aria-label="Close shop manager" />
      <aside className="dc-drawer">
        <header className="dc-drawer-head">
          <div><p>Shop management</p><h2 id="shop-drawer-title">{shop.shop}</h2></div>
          <Link className="dc-drawer-close" to={closeManageUrl(query)} aria-label="Close">×</Link>
        </header>
        <div className="dc-drawer-body">
          <DrawerSection title="Shop overview">
            <div className="dc-detail-grid">
              <Stat label="Lifecycle" value={shop.lifecycleStatus} />
              <Stat label="AI state" value={shop.state.aiOperational ? "Operational" : shop.state.aiConfigured ? "Not entitled" : "Disabled"} />
              <Stat label="Estimated API cost MTD" value={shop.cost.unknownCostRequests > 0 ? "Incomplete" : usd(shop.cost.mtdUsd)} />
              <Stat label="Retained vectors" value={number(shop.quota.products.retained)} />
            </div>
          </DrawerSection>

          <DrawerSection title="Commercial">
            <div className="dc-detail-grid">
              <Stat label="Current plan" value={shop.commercial.planLabel} />
              <Stat
                label="Pending plan"
                value={
                  shop.pendingPlanHandle
                    ? shop.pendingPlanHandle.toLowerCase() === "custom"
                      ? shop.customConfig?.name ?? "Custom"
                      : shop.pendingPlanHandle
                    : "—"
                }
              />
              <Stat label="Subscription" value={shop.subscriptionStatus} />
              <Stat label="Active billed price" value={shop.commercial.priceSnapshot === null ? "—" : `${formatMoney(shop.commercial.priceSnapshot, shop.commercial.currency ?? "USD")}${shop.commercial.interval === "ANNUAL" ? " / year" : " / month"}`} />
              <Stat label="Billing cycle ends" value={formatDate(shop.commercial.periodEnd)} />
            </div>
            {shop.commercial.customTerms ? (
              <div className="dc-commercial-compare">
                <div><small>Configured Custom terms</small><strong>{shop.commercial.customTerms.price === null ? "—" : `${formatMoney(shop.commercial.customTerms.price, shop.commercial.customTerms.currency)}${shop.commercial.customTerms.interval === "ANNUAL" ? " / year" : " / month"}`}</strong></div>
                <div><small>Shopify subscription</small><strong>{shop.commercial.activePaid ? "Active" : "Not active"}</strong></div>
                {shop.commercial.customTerms.pendingCommercialChange ? <StatusBadge tone="warning">Pending commercial change</StatusBadge> : null}
              </div>
            ) : null}
          </DrawerSection>

          <DrawerSection title="Usage">
            <div className="dc-usage-lines">
              <QuotaLine label="Products" quota={shop.quota.products} active={shop.subscriptionStatus === "ACTIVE"} />
              <QuotaLine label="Searches" quota={shop.quota.searches} active={shop.subscriptionStatus === "ACTIVE"} />
              <QuotaLine label="Vector updates" quota={shop.quota.vectorUpdates} active={shop.subscriptionStatus === "ACTIVE"} />
            </div>
          </DrawerSection>

          <DrawerSection title="Support grants">
            {grants.length ? <div className="dc-grant-list">{grants.map((grant) => (
              <div className="dc-grant" key={grant.id}>
                <div><strong>+{number(grant.amount)} {quotaKind(grant.kind)}</strong><small>{shop.subscriptionStatus === "ACTIVE" ? "Effective grant" : "Stored grant"} · expires {grant.expiresAt ? formatDate(grant.expiresAt) : "never"}</small><small>{grant.reason}</small></div>
                {canQuotaWrite ? <Form method="post"><MutationFields csrfToken={csrfToken} intent="revoke_grant" shop={shop.shop} /><input type="hidden" name="grantId" value={grant.id} /><input type="hidden" name="reason" value="Revoked from Dev Center" /><button className="dc-link-danger" disabled={busy} type="submit">Revoke</button></Form> : null}
              </div>
            ))}</div> : <Empty>No active stored grants.</Empty>}
            {canQuotaWrite ? (
              <Form method="post" className="dc-form-card">
                <MutationFields csrfToken={csrfToken} intent="grant_quota" shop={shop.shop} />
                <input type="hidden" name="grantRequestId" value={grantRequestId} />
                <div className="dc-form-grid-3">
                  <Field label="Quota"><select name="kind" defaultValue="SEARCH"><option value="SEARCH">Searches</option><option value="PRODUCT">Products</option><option value="VECTOR_UPDATE">Vector updates</option></select></Field>
                  <Field label="Amount"><input name="amount" type="number" min="1" required /></Field>
                  <Field label="Expiry"><select name="expiryMode" defaultValue="BILLING_CYCLE"><option value="BILLING_CYCLE">End of billing cycle</option><option value="30_DAYS">30 days</option><option value="NEVER">No expiry</option></select></Field>
                </div>
                <Field label="Note"><input name="reason" placeholder="Optional note" /></Field>
                <button className="dc-button dc-button-primary" disabled={busy} type="submit">Add grant</button>
              </Form>
            ) : <ReadOnly />}
          </DrawerSection>

          <DrawerSection title="Custom plan">
            <p className="dc-section-copy">
              Shop-specific plan. Once saved, these terms remain attached to this shop and the Custom plan is shown only in this shop&apos;s Billing page.
            </p>
            {canPlanWrite ? (
              <Form method="post" className="dc-form-card">
                <MutationFields csrfToken={csrfToken} intent="set_custom_plan" shop={shop.shop} />

                <div className="dc-form-grid-2">
                  <Field label="Plan name">
                    <input name="customName" required defaultValue={shop.customConfig?.name ?? "Custom"} />
                  </Field>
                  <Field label="Price">
                    <input name="customPrice" type="number" min="0.01" step="0.01" defaultValue={shop.customConfig?.price ?? ""} required />
                  </Field>
                  <Field label="Currency">
                    <input name="customCurrency" maxLength={3} required defaultValue={shop.customConfig?.currencyCode ?? "USD"} />
                  </Field>
                  <Field label="Billing interval">
                    <select name="customInterval" defaultValue={shop.customConfig?.interval ?? "EVERY_30_DAYS"}>
                      <option value="EVERY_30_DAYS">Every 30 days</option>
                      <option value="ANNUAL">Annual</option>
                    </select>
                  </Field>
                  <Field label="Free trial (not available for Custom)">
                    <input name="customTrialDays" type="number" value={0} readOnly />
                  </Field>
                  <Field label="Money-back guarantee days (0 = disabled)">
                    <input name="customMoneyBackDays" type="number" min="0" max="365" step="1" defaultValue={shop.customConfig?.features.billingPolicy.moneyBackGuaranteeDays ?? 0} />
                  </Field>
                  <Field label="Refund terms">
                    <textarea name="customRefundTerms" maxLength={2000} rows={3} defaultValue={shop.customConfig?.features.billingPolicy.refundTerms ?? ""} />
                  </Field>
                  <Field label="Product limit">
                    <input name="customProductLimit" type="number" min="0" defaultValue={shop.customConfig?.productLimit ?? ""} placeholder="Blank = unlimited" />
                  </Field>
                  <Field label="Monthly searches">
                    <input name="customSearchLimit" type="number" min="0" defaultValue={shop.customConfig?.searchLimit ?? ""} placeholder="Blank = unlimited" />
                  </Field>
                  <Field label="Monthly vector updates">
                    <input name="customVectorUpdateLimit" type="number" min="0" defaultValue={shop.customConfig?.vectorUpdateLimit ?? ""} placeholder="Blank = unlimited" />
                  </Field>
                </div>

                <Field label="Merchant-facing description">
                  <textarea name="customDescription" rows={2} defaultValue={shop.customConfig?.features.description ?? ""} />
                </Field>

                <div>
                  <strong style={{ display: "block", fontSize: 13, marginBottom: 8 }}>Included capabilities</strong>
                  <div className="dc-form-grid-2">
                    {PLAN_CAPABILITIES.map(([key, label]) => (
                      <label key={key} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                        <input
                          type="checkbox"
                          name="customCapability"
                          value={key}
                          defaultChecked={shop.customConfig
                            ? shop.customConfig.features.capabilities[key]
                            : key !== "customDataMode"}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>

                <Field label="Merchant-facing highlights (one per line)">
                  <textarea
                    name="customHighlights"
                    rows={4}
                    defaultValue={shop.customConfig?.features.highlights.join("\n") ?? ""}
                    placeholder={"Priority indexing\nAdvanced analytics\nDedicated support"}
                  />
                </Field>

                <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                  <input
                    type="checkbox"
                    name="customUsageBillingEnabled"
                    defaultChecked={shop.customConfig?.usageBillingEnabled ?? false}
                  />
                  Usage billing enabled
                </label>

                <Field label="Note">
                  <input name="reason" defaultValue={shop.customConfig?.notes ?? ""} />
                </Field>
                <button className="dc-button dc-button-primary" disabled={busy} type="submit">
                  {busy ? "Saving..." : shop.customConfig ? "Update Custom plan" : "Create Custom plan for this shop"}
                </button>
              </Form>
            ) : <ReadOnly />}
          </DrawerSection>

          <DrawerSection title="AI Search">
            <div className="dc-inline-control">
              <div><strong>{shop.adminEnabled ? "Admin allowed" : "Admin suspended"}</strong><small>{shop.merchantEnabled ? "Merchant enabled" : "Merchant disabled"}; {shop.state.aiOperational ? "AI operational" : "AI not operational"}</small></div>
              {canSystemWrite ? (
                <Form method="post" className="dc-inline-form">
                  <MutationFields csrfToken={csrfToken} intent="toggle_ai" shop={shop.shop} />
                  <input type="hidden" name="enabled" value={shop.adminEnabled ? "false" : "true"} />
                  <input name="reason" required placeholder="Reason" />
                  <button className={`dc-button ${shop.adminEnabled ? "dc-button-danger" : "dc-button-primary"}`} disabled={busy} type="submit">{shop.adminEnabled ? "Suspend" : "Allow"}</button>
                </Form>
              ) : <ReadOnly />}
            </div>
          </DrawerSection>

          <details className="dc-advanced">
            <summary>Advanced controls</summary>
            <p>Absolute limit overrides bypass normal plan defaults. Recent strong authentication is required.</p>
            {canQuotaWrite ? (
              <Form method="post" className="dc-form-card">
                <MutationFields csrfToken={csrfToken} intent="set_limits" shop={shop.shop} />
                <div className="dc-form-grid-3">
                  <Field label="Products"><input name="productLimitOverride" type="number" min="0" defaultValue={shop.overrides.product ?? ""} placeholder="Plan default" /></Field>
                  <Field label="Searches"><input name="searchLimitOverride" type="number" min="0" defaultValue={shop.overrides.search ?? ""} placeholder="Plan default" /></Field>
                  <Field label="Vectors"><input name="vectorUpdateLimitOverride" type="number" min="0" defaultValue={shop.overrides.vectorUpdate ?? ""} placeholder="Plan default" /></Field>
                </div>
                <Field label="Reason"><input name="reason" required /></Field>
                <button className="dc-button" disabled={busy} type="submit">Save absolute overrides</button>
              </Form>
            ) : <ReadOnly />}
          </details>
        </div>
      </aside>
    </div>
  );
}

export function DevLoader({ label = "Loading..." }: { label?: string }) {
  return (
    <div className="dc-loader-overlay" role="status" aria-live="polite" aria-busy="true">
      <div className="dc-loader-card">
        <span className="dc-loader-spinner" aria-hidden="true" />
        <div>
          <strong>{label}</strong>
          <small>Please keep this page open.</small>
        </div>
      </div>
    </div>
  );
}

function NavItem({ href, label, icon }: { href: string; label: string; icon: string }) {
  return <a href={href}><span>{icon}</span>{label}</a>;
}
function SectionHeader({ eyebrow, title, note, action }: { eyebrow: string; title: string; note: string; action?: ReactNode }) {
  return <div className="dc-section-head"><div><p>{eyebrow}</p><h2>{title}</h2><small>{note}</small></div>{action}</div>;
}
function Metric({ label, value, note, tone = "neutral" }: { label: string; value: ReactNode; note: ReactNode; tone?: Tone }) {
  return <article className={`dc-metric is-${tone}`}><span>{label}</span><strong>{value}</strong><small>{note}</small></article>;
}
function StatusBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`dc-badge is-${tone}`}><i />{children}</span>;
}
function QuotaCell({ quota, active }: { quota: { used: number; limit: number | null; storedGrant: number }; active: boolean }) {
  return <div className="dc-quota-cell"><strong>{quotaText(quota.used, quota.limit)}</strong>{quota.storedGrant > 0 ? <small>{active ? "Grant" : "Stored grant"} +{number(quota.storedGrant)}</small> : null}</div>;
}
function QuotaLine({ label, quota, active }: { label: string; quota: { used: number; limit: number | null; storedGrant: number }; active: boolean }) {
  const percent = quota.limit && quota.limit > 0 ? Math.min(100, (quota.used / quota.limit) * 100) : 0;
  return <div className="dc-quota-line"><div><span>{label}</span><strong>{quotaText(quota.used, quota.limit)}</strong></div><div className="dc-meter"><i style={{ width: `${percent}%` }} /></div>{quota.storedGrant > 0 ? <small>{active ? "Effective grant" : "Stored grant"} +{number(quota.storedGrant)}</small> : null}</div>;
}
function UsageCard({ label, value, cost, detail }: { label: string; value: string; cost: string; detail: string }) {
  return <article className="dc-usage-card"><span>{label}</span><strong>{value}</strong><div><b>{cost}</b><small>{detail}</small></div></article>;
}
function Stat({ label, value }: { label: string; value: ReactNode }) { return <div className="dc-stat"><span>{label}</span><strong>{value}</strong></div>; }
function DrawerSection({ title, children }: { title: string; children: ReactNode }) { return <section className="dc-drawer-section"><h3>{title}</h3>{children}</section>; }
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="dc-field"><span>{label}</span>{children}</label>; }
function MutationFields({ csrfToken, intent, shop }: { csrfToken: string; intent: string; shop: string }) { return <><input type="hidden" name="_csrf" value={csrfToken} /><input type="hidden" name="intent" value={intent} /><input type="hidden" name="targetShop" value={shop} /></>; }
function Empty({ children }: { children: ReactNode }) { return <div className="dc-empty">{children}</div>; }
function ReadOnly() { return <span className="dc-readonly">Read-only access</span>; }
function AuditPanel({ title, empty, children }: { title: string; empty: string; children: ReactNode[] }) { return <div className="dc-panel"><h3>{title}</h3><div className="dc-audit-list">{children.length ? children : <Empty>{empty}</Empty>}</div></div>; }

function BusinessAudit({ event }: { event: DevDashboardData["recentAudit"][number] }) {
  const before = json(event.beforeJson);
  const after = json(event.afterJson);
  let title = event.action.replaceAll("_", " ").toLowerCase();
  let detail = event.reason || "No reason recorded";
  if (event.action === "QUOTA_GRANT_CREATED") { title = `Added +${after.amount ?? "—"} ${quotaKind(String(after.kind ?? "quota"))}`; detail = `${event.targetShop} · expires ${after.expiresAt ? formatDate(String(after.expiresAt)) : "never"}`; }
  if (event.action === "QUOTA_GRANT_REVOKED") title = `Revoked ${quotaKind(String(before.kind ?? "quota"))} grant`;
  if (event.action === "CUSTOM_PLAN_TERMS_CHANGED") { title = "Changed Custom plan terms"; detail = `${event.targetShop} · price ${value(before.customPriceOverride)} → ${value(after.customPriceOverride)} · ${event.reason ?? "No reason"}`; }
  if (event.action === "ABSOLUTE_QUOTA_OVERRIDE_CHANGED") title = "Changed absolute limits";
  if (event.action === "AI_SEARCH_ENABLED_BY_ADMIN") title = "Enabled AI Search";
  if (event.action === "AI_SEARCH_DISABLED_BY_ADMIN") title = "Disabled AI Search";
  return <div className="dc-audit-row"><div><strong>{title}</strong><small>{detail}</small><small>By {event.actorShop.replace(/^dev:/, "")} · {formatDate(event.createdAt)}</small></div></div>;
}

function lifecycleTone(status: string): Tone { return status === "ACTIVE" ? "success" : /FROZEN|SUSPEND/.test(status) ? "warning" : /UNINSTALL|INACTIVE/.test(status) ? "danger" : "neutral"; }
function subscriptionTone(status: string): Tone { return status === "ACTIVE" ? "success" : status === "FROZEN" || status === "PENDING" ? "warning" : "neutral"; }
function commercialPrice(shop: Shop) { if (shop.commercial.priceSnapshot !== null) return `${formatMoney(shop.commercial.priceSnapshot, shop.commercial.currency ?? "USD")}${shop.commercial.interval === "ANNUAL" ? " / year" : " / month"}`; if (shop.commercial.customTerms?.price) return `Configured ${formatMoney(shop.commercial.customTerms.price, shop.commercial.customTerms.currency)}${shop.commercial.customTerms.interval === "ANNUAL" ? " / year" : " / month"} · not billed`; return "No active billed price"; }
function manageUrl(query: string, shop: string) { const params = new URLSearchParams(); if (query) params.set("q", query); params.set("manage", shop); return `/dev?${params.toString()}#shops`; }
function closeManageUrl(query: string) { return query ? `/dev?q=${encodeURIComponent(query)}#shops` : "/dev#shops"; }
function quotaText(used: number, limit: number | null) { return `${number(used)} / ${limit === null ? "Unlimited" : number(limit)}`; }
function quotaKind(kind: string) { return kind === "SEARCH" ? "searches" : kind === "PRODUCT" ? "products" : kind === "VECTOR_UPDATE" ? "vector updates" : kind.toLowerCase(); }
function number(value: number) { return value.toLocaleString(); }
function usd(value: number) { return `$${value.toFixed(2)}`; }
function usdNullable(value: number | null) { return value === null ? "—" : usd(value); }
function formatMoney(value: number, currency: string) { try { return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(value); } catch { return `${value.toFixed(2)} ${currency}`; } }
function moneyList(items: Array<{ currency: string; mrr: number }>) { return items.length ? items.map((item) => formatMoney(item.mrr, item.currency)).join(" · ") : "—"; }
function formatDate(value: string | Date | null) { if (!value) return "—"; return new Date(value).toLocaleString(); }
function json(value: string | null): Record<string, unknown> { if (!value) return {}; try { const parsed: unknown = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; } }
function prettyJson(value: string | null) { if (!value) return "No LLM analysis recorded."; try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; } }
function value(input: unknown) { return input === null || input === undefined || input === "" ? "default" : String(input); }
function securityLabel(action: string) { const labels: Record<string, string> = { DEV_LOGIN_SUCCESS: "Login successful", DEV_PASSWORD_VERIFIED: "Password verified", DEV_MFA_SUCCESS: "MFA verified", DEV_LOGOUT: "Logged out", DEV_LOGIN_FAILED: "Login failed", DEV_MFA_FAILED: "MFA failed" }; return labels[action] ?? action.replaceAll("_", " ").toLowerCase(); }
