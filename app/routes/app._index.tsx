import { useEffect } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { Link, useFetcher, useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import { getShopEntitlement } from "../services/commerce/entitlement.server";
import { getProductSyncQueueStats } from "../services/products/product-sync-job.server";
import { getLatestCatalogSyncJob } from "../services/catalog/catalog-sync-job.server";
import { getThemeAppEmbedDeepLink } from "../services/theme/app-embed.server";
import { getThemeIntegrationStatus } from "../services/theme/theme-integration.server";
import { getShopSettings } from "../services/commerce/shop-registry.server";
import { getSearchImpactSnapshot } from "../services/search/search-impact.server";

type UiState = "success" | "warning" | "critical" | "neutral";

type DashboardStatus = {
  updatedAt: string;

  subscription: {
    ready: boolean;
    status: string;
  };

  catalog: {
    ready: boolean;
    busy: boolean;
    failed: boolean;
    status: string;
    pending: number;
    processing: number;
    failedCount: number;
    productsProcessed: number;
    productsIndexed: number;
  };

  aiEngine: {
    ready: boolean;
    status: string;
  };

  appEmbed: {
    ready: boolean;
    status: string;
    themeName: string | null;
  };

  themeMap: {
    ready: boolean;
    status: string;
  };

  allReady: boolean;
};

type ThemeSummary = {
  integrationStatus: string;
  integrationReady: boolean;
  themeMapReady: boolean;
  appEmbedEnabled: boolean | null;
  themeName: string | null;
  renderStrategy: string | null;
};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function isThemeExecutionReady(args: {
  status: string;
  themeMapReady: boolean;
  renderStrategy: string | null;
}) {
  if (args.themeMapReady) return true;

  const status = args.status.toUpperCase();
  const strategy = (args.renderStrategy ?? "").toUpperCase();

  if (
    strategy.includes("THEME_CONTEXT_REQUIRED") ||
    strategy.includes("TRANSPORT") ||
    status.includes("THEME_CONTEXT_REQUIRED") ||
    status.includes("TRANSPORT")
  ) {
    return true;
  }

  return ["READY", "ACTIVE", "VERIFIED", "SUPPORTED"].some((token) =>
    status.includes(token),
  );
}

function normalizeThemeIntegration(value: unknown): ThemeSummary {
  const integration = objectValue(value);
  const appEmbed = objectValue(integration.appEmbed);
  const themeMap = objectValue(integration.themeMap);

  const status =
    stringValue(integration.status) ??
    stringValue(integration.reason) ??
    "UNKNOWN";

  const themeMapReady =
    integration.themeMapReady === true ||
    themeMap.status === "VERIFIED" ||
    integration.ready === true;

  const renderStrategy =
    stringValue(integration.renderStrategy) ??
    stringValue(themeMap.renderStrategy) ??
    stringValue(integration.rendererMode) ??
    null;

  return {
    integrationStatus: status,
    integrationReady: isThemeExecutionReady({
      status,
      themeMapReady,
      renderStrategy,
    }),
    themeMapReady,
    appEmbedEnabled: booleanValue(appEmbed.enabled),
    themeName:
      stringValue(appEmbed.themeName) ??
      stringValue(integration.themeName) ??
      stringValue(themeMap.themeName),
    renderStrategy,
  };
}

function normalizeSettings(value: unknown) {
  const settings = objectValue(value);

  return {
    aiSearchEnabled:
      typeof settings.aiSearchEnabled === "boolean"
        ? settings.aiSearchEnabled
        : true,
    searchLanguage: stringValue(settings.searchLanguage),
    resultLimit:
      typeof settings.resultLimit === "number" ? settings.resultLimit : null,
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const [entitlement, queue, catalogJob, themeIntegration, settings, searchImpact] =
    await Promise.all([
      getShopEntitlement(session.shop),
      getProductSyncQueueStats(session.shop),
      getLatestCatalogSyncJob(session.shop),
      getThemeIntegrationStatus({ admin, shop: session.shop }),
      getShopSettings(session.shop),
      getSearchImpactSnapshot(session.shop, { windowDays: 30 }),
    ]);

  return {
    shop: session.shop,
    entitlement,
    queue,
    settings: normalizeSettings(settings),
    searchImpact,
    theme: normalizeThemeIntegration(themeIntegration),
    catalogJob: catalogJob
      ? {
          status: catalogJob.status,
          productsProcessed: catalogJob.productsProcessed,
          productsIndexed: catalogJob.productsIndexed,
          productsSkipped: catalogJob.productsSkipped,
          productsBlocked: catalogJob.productsBlocked,
          productsFailed: catalogJob.productsFailed,
          lastError: catalogJob.lastError,
        }
      : null,
    appEmbedUrl: getThemeAppEmbedDeepLink(session.shop),
  };
};

function formatLimit(value: number | null) {
  return value === null ? "Unlimited" : value.toLocaleString("en-US");
}

function formatUsage(used: number, limit: number | null) {
  return `${used.toLocaleString("en-US")} / ${formatLimit(limit)}`;
}

function remaining(limit: number | null, used: number) {
  return limit === null ? null : Math.max(0, limit - used);
}

function percentage(used: number, limit: number | null) {
  if (limit === null || limit <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
}

function StatusPill({ state, children }: { state: UiState; children: string }) {
  return (
    <span className={`vip-pill vip-pill--${state}`}>
      <span className="vip-pill__dot" />
      {children}
    </span>
  );
}

function MetricCard({
  eyebrow,
  value,
  detail,
  progress,
  accent = "violet",
  isSyncing = false,
}: {
  eyebrow: string;
  value: string;
  detail: string;
  progress?: number | null;
  accent?: "violet" | "cyan";
  isSyncing?: boolean;
}) {
  return (
    <div className={`vip-metric vip-metric--${accent}`}>
      <div className="vip-metric__top">
        <span className="vip-metric__eyebrow">{eyebrow}</span>
        {isSyncing ? (
          <span className="vip-syncing-tag">
            <span className="vip-spinner" /> Syncing...
          </span>
        ) : (
          <span className="vip-metric__spark" aria-hidden="true" />
        )}
      </div>
      <div className="vip-metric__value">{value}</div>
      <div className="vip-metric__detail">{detail}</div>
      {typeof progress === "number" ? (
        <div className="vip-progress" aria-label={`${progress}%`}>
          <span style={{ width: `${progress}%` }} />
        </div>
      ) : null}
    </div>
  );
}

function ReadinessStep({
  index,
  title,
  state,
  status,
  action,
  actionNode,
}: {
  index: number;
  title: string;
  state: UiState;
  status: string;
  action?: { label: string; href: string; targetTop?: boolean };
  actionNode?: React.ReactNode;
}) {
  return (
    <div className="vip-step-card">
      <div className="vip-step-card__head">
        <span className={`vip-step-badge vip-step-badge--${state}`}>{index}</span>
        <StatusPill state={state}>{status}</StatusPill>
      </div>
      <strong className="vip-step-card__title">{title}</strong>
      <div className="vip-step-card__action">
        {actionNode ? (
          actionNode
        ) : action ? (
          action.targetTop ? (
            <a href={action.href} target="_top" rel="noreferrer">
              {action.label}
            </a>
          ) : (
            <Link to={action.href}>{action.label}</Link>
          )
        ) : null}
      </div>
    </div>
  );
}

function HealthRow({
  label,
  value,
  state,
}: {
  label: string;
  value: string;
  state: UiState;
}) {
  return (
    <div className="vip-health-row">
      <div className="vip-health-label">
        <span className={`vip-health-dot vip-health-dot--${state}`} />
        {label}
      </div>
      <strong>{value}</strong>
    </div>
  );
}

function QuickLink({
  title,
  detail,
  href,
  targetTop,
}: {
  title: string;
  detail: string;
  href: string;
  targetTop?: boolean;
}) {
  const content = (
    <>
      <div>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      <span className="vip-quick-arrow">→</span>
    </>
  );

  return targetTop ? (
    <a className="vip-quick-link" href={href} target="_top" rel="noreferrer">
      {content}
    </a>
  ) : (
    <Link className="vip-quick-link" to={href}>
      {content}
    </Link>
  );
}

function fmtPct(value: number | null) {
  return value == null
    ? "—"
    : `${value.toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
}

function signedPct(value: number | null, suffix = "%") {
  if (value == null) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toLocaleString("en-US", {
    maximumFractionDigits: 1,
  })}${suffix}`;
}

function SearchPerformanceChart({
  series,
}: {
  series: Array<{
    date: string;
    searches: number;
    clickedSearches: number;
    abnormalSearches: number;
  }>;
}) {
  const visible = series.slice(-7);
  const totalSearches = visible.reduce((sum, item) => sum + item.searches, 0);

  if (totalSearches === 0) {
    return (
      <div className="vip-chart-empty">
        No AI search activity recorded in the last 7 days.
      </div>
    );
  }

  const width = 720;
  const height = 210;
  const padLeft = 38;
  const padRight = 18;
  const padTop = 20;
  const padBottom = 18;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  const rawMax = Math.max(
    ...visible.flatMap((item) => [
      item.searches,
      item.clickedSearches,
      item.abnormalSearches,
    ]),
    1,
  );
  const maxY =
    rawMax <= 4
      ? 4
      : rawMax <= 20
        ? Math.ceil(rawMax / 5) * 5
        : Math.ceil(rawMax / 10) * 10;

  const xFor = (index: number) =>
    padLeft + (index / Math.max(1, visible.length - 1)) * plotWidth;
  const yFor = (value: number) =>
    padTop + plotHeight - (value / maxY) * plotHeight;

  const buildPoints = (
    valueOf: (item: (typeof visible)[number]) => number,
  ) =>
    visible
      .map((item, index) => `${xFor(index)},${yFor(valueOf(item))}`)
      .join(" ");

  const lines = [
    {
      key: "searches",
      label: "Total searches",
      stroke: "#6f5cf5",
      valueOf: (item: (typeof visible)[number]) => item.searches,
    },
    {
      key: "clickedSearches",
      label: "Searches with click",
      stroke: "#21a366",
      valueOf: (item: (typeof visible)[number]) => item.clickedSearches,
    },
    {
      key: "abnormalSearches",
      label: "Search anomalies",
      stroke: "#d89a17",
      valueOf: (item: (typeof visible)[number]) => item.abnormalSearches,
    },
  ];

  return (
    <div className="vip-chart-shell">
      <div className="vip-chart-legend" aria-label="Chart Legend">
        {lines.map((line) => (
          <span key={line.key}>
            <i style={{ background: line.stroke }} />
            {line.label}
          </span>
        ))}
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Total AI searches"
        className="vip-chart"
      >
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const y = padTop + ratio * plotHeight;
          const value = Math.round(maxY * (1 - ratio));
          return (
            <g key={ratio}>
              <line
                x1={padLeft}
                x2={width - padRight}
                y1={y}
                y2={y}
                stroke="rgba(104,97,150,.12)"
                strokeWidth="1"
              />
              <text x={8} y={Math.max(12, y + 3)} className="vip-chart-label">
                {value}
              </text>
            </g>
          );
        })}

        {lines.map((line) => (
          <g key={line.key}>
            <polyline
              points={buildPoints(line.valueOf)}
              fill="none"
              stroke={line.stroke}
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {visible.map((item, index) => {
              const value = line.valueOf(item);
              return (
                <circle
                  key={`${line.key}-${item.date}`}
                  cx={xFor(index)}
                  cy={yFor(value)}
                  r="3.5"
                  fill="#ffffff"
                  stroke={line.stroke}
                  strokeWidth="2"
                >
                  <title>{`${item.date} · ${line.label}: ${value}`}</title>
                </circle>
              );
            })}
          </g>
        ))}
      </svg>

      <div className="vip-chart-axis vip-chart-axis--7">
        {visible.map((item) => (
          <span key={item.date}>{item.date.slice(5).replace("-", "/")}</span>
        ))}
      </div>
    </div>
  );
}

function AlertTypeLabel(type: string) {
  if (type === "NO_RESULTS") return "No Results";
  if (type === "LOW_SIMILARITY") return "Low Similarity";
  if (type === "HIGH_SIMILARITY_NO_CLICK") return "High Similarity (No Click)";
  if (type === "CTR_DROP") return "CTR Drop";
  return type;
}

const dashboardCss = `
  .vip-shell {
    --vip-text: #1a1c23;
    --vip-muted: #5c6270;
    --vip-border: #e2e4ed;
    --vip-panel: #ffffff;
    --vip-shadow: 0 4px 20px rgba(0, 0, 0, 0.03);
    display: grid;
    gap: 20px;
    color: var(--vip-text);
    padding-bottom: 32px;
    width: 100%;
    box-sizing: border-box;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }

  .vip-setup-box {
  border: 1px solid var(--vip-border);
  border-radius: 16px;
  background: var(--vip-panel);
  box-shadow: var(--vip-shadow);
  padding: 16px 20px;
}

  .vip-setup-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
  padding-bottom: 12px;
  border-bottom: 1px solid #f0f0f4;
}

.vip-setup-title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.vip-setup-title h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 800;
  line-height: 1.2;
}
.vip-setup-title span:not(.vip-setup-icon) {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  color: var(--vip-muted);
}

.vip-setup-icon {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border-radius: 9px;
  background: #f1f0fb;
  color: #6f5cf5;
  font-size: 15px;
  font-weight: 800;
}
  .vip-setup-head h3 {
    margin: 0;
    font-size: 18px;
    font-weight: 800;
  }

  .vip-setup-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
}


  .vip-step-card {
  min-width: 0;
  min-height: 72px;
  padding: 10px 12px;
  border: 1px solid #eef0f4;
  border-radius: 12px;
  background: #fcfcfd;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  transition: border-color .15s ease, box-shadow .15s ease, transform .15s ease;
}

 .vip-step-card:hover {
  border-color: #d8dbe3;
  box-shadow: 0 4px 12px rgba(0,0,0,.04);
  transform: translateY(-1px);
}

.vip-step-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 7px;
}

 .vip-step-badge {
  width: 21px;
  height: 21px;
  border-radius: 7px;
  font-size: 10px;
}
  .vip-step-badge--success { color: #008060; background: #e4f8f0; }
  .vip-step-badge--warning { color: #8a5b00; background: #fff6df; }
  .vip-step-badge--critical { color: #d32f2f; background: #ffebe9; }
  .vip-step-badge--neutral { color: #5c6270; background: #f1f2f3; }

  .vip-step-card__title {
  font-size: 13px;
  font-weight: 800;
  line-height: 1.2;
}

.vip-step-card__action {
  margin-top: 5px;
  min-height: 16px;
  font-size: 11px;
  font-weight: 700;
}

  .vip-step-card__action a {
  color: #008060;
  text-decoration: none;
}

  .vip-step-card__action a:hover {
    text-decoration: underline;
  }

  .vip-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border-radius: 999px;
  padding: 3px 7px;
  font-size: 10px;
  font-weight: 800;
  white-space: nowrap;
}

  .vip-pill__dot { width: 6px; height: 6px; border-radius: 50%; }
  .vip-pill--success { background: #e4f8f0; color: #008060; }
  .vip-pill--success .vip-pill__dot { background: #008060; }
  .vip-pill--warning { background: #fff6df; color: #8a5b00; }
  .vip-pill--warning .vip-pill__dot { background: #d89a17; }
  .vip-pill--critical { background: #ffebe9; color: #d32f2f; }
  .vip-pill--critical .vip-pill__dot { background: #d32f2f; }
  .vip-pill--neutral { background: #f1f2f3; color: #5c6270; }
  .vip-pill--neutral .vip-pill__dot { background: #8c9196; }

 .vip-check-button {
  appearance: none;
  border: 0;
  padding: 0;
  background: transparent;
  color: #008060;
  font: inherit;
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
}

.vip-check-button:hover {
  text-decoration: underline;
}

.vip-check-button:disabled {
  cursor: default;
  opacity: .65;
  text-decoration: none;
}

  @keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }
  .vip-spinner {
    display: inline-block;
    width: 10px;
    height: 10px;
    border: 2px solid rgba(0, 128, 96, 0.2);
    border-radius: 50%;
    border-top-color: #008060;
    animation: spin 0.8s linear infinite;
  }
  .vip-syncing-tag {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    font-weight: 800;
    color: #008060;
    background: #e4f8f0;
    padding: 2px 8px;
    border-radius: 12px;
  }

  .vip-main-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.4fr) minmax(320px, 0.85fr);
    gap: 20px;
    align-items: stretch;
  }

  .vip-left-col {
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .vip-two-metrics {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
  }

  .vip-metric {
    position: relative;
    overflow: hidden;
    border: 1px solid var(--vip-border);
    border-radius: 20px;
    padding: 22px;
    background: var(--vip-panel);
    box-shadow: var(--vip-shadow);
  }

  .vip-metric__top { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
  .vip-metric__eyebrow { color: #5c6270; font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; }
  .vip-metric__spark { width: 8px; height: 8px; border-radius: 50%; background: currentColor; opacity: .65; }
  .vip-metric__value { margin-top: 14px; font-size: 32px; font-weight: 800; color: var(--vip-text); }
  .vip-metric__detail { margin-top: 6px; color: var(--vip-muted); font-size: 13px; line-height: 1.4; }

  .vip-progress { height: 7px; margin-top: 16px; border-radius: 999px; background: #eef0f4; overflow: hidden; }
  .vip-progress span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #008060, #28b8d5); transition: width 0.4s ease; }

  .vip-panel {
    border: 1px solid var(--vip-border);
    border-radius: 20px;
    background: var(--vip-panel);
    box-shadow: var(--vip-shadow);
    overflow: hidden;
  }

  .vip-impact { padding: 22px 24px; }

  .vip-impact-head {
    display: flex;
    justify-content: space-between;
    gap: 18px;
    align-items: flex-start;
    margin-bottom: 16px;
  }

  .vip-impact-head h3 {
    margin: 0;
    font-size: 18px;
    font-weight: 800;
  }

  .vip-impact-kpis {
    display: grid;
    grid-template-columns: repeat(4, minmax(0,1fr));
    gap: 12px;
    margin-bottom: 18px;
  }

  .vip-impact-kpi {
    border: 1px solid #eef0f4;
    border-radius: 14px;
    padding: 12px 14px;
    background: #fafafa;
  }

  .vip-impact-kpi span {
    display: block;
    color: #5c6270;
    font-size: 11px;
    font-weight: 800;
    text-transform: uppercase;
  }

  .vip-impact-kpi strong {
    display: block;
    margin-top: 6px;
    font-size: 22px;
    font-weight: 800;
  }

  .vip-impact-kpi small {
    display: block;
    margin-top: 4px;
    color: var(--vip-muted);
    font-size: 11px;
  }

  .vip-chart-shell {
    border: 1px solid #eef0f4;
    border-radius: 16px;
    padding: 14px 12px 8px;
    background: #ffffff;
  }

  .vip-chart { display: block; width: 100%; height: 210px; }
  .vip-chart-label { font-size: 11px; fill: #8c9196; }
  .vip-chart-axis--7 {
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
    padding: 0 14px 4px;
    text-align: center;
    font-size: 11px;
    color: #8c9196;
  }

  .vip-chart-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    padding: 0 6px 10px;
    color: var(--vip-muted);
    font-size: 12px;
    font-weight: 700;
  }

  .vip-chart-legend span { display: inline-flex; align-items: center; gap: 6px; }
  .vip-chart-legend i { width: 8px; height: 8px; border-radius: 999px; display: inline-block; }

  .vip-chart-empty {
    min-height: 190px;
    display: grid;
    place-items: center;
    border: 1px dashed #dcd9e8;
    border-radius: 14px;
    color: #8c9196;
    font-size: 13px;
  }

  .vip-alerts {
    padding: 22px 24px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    height: 100%;
    box-sizing: border-box;
  }

  .vip-alerts h3 {
    margin: 0;
    font-size: 18px;
    font-weight: 800;
  }

  .vip-alert-list { display: grid; gap: 12px; margin-top: 16px; }
  .vip-alert {
    display: grid;
    grid-template-columns: 8px minmax(0,1fr) auto;
    gap: 12px;
    align-items: start;
    padding: 12px 0;
    border-bottom: 1px solid #f0f0f4;
  }
  .vip-alert:last-child { border-bottom: 0; }
  .vip-alert__dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 4px; }
  .vip-alert--high .vip-alert__dot { background: #d32f2f; }
  .vip-alert--medium .vip-alert__dot { background: #d89a17; }
  .vip-alert__title { font-size: 13px; font-weight: 800; display: flex; gap: 6px; align-items: center; }
  .vip-alert__query { margin-top: 4px; font-size: 13px; font-weight: 700; }
  .vip-alert__detail { margin-top: 4px; color: var(--vip-muted); font-size: 12px; }
  .vip-alert__count { border-radius: 999px; padding: 4px 10px; background: #f1f0fb; color: #008060; font-size: 12px; font-weight: 800; }

  .vip-alerts-healthy-box {
    margin-top: 16px;
    padding: 18px;
    border-radius: 16px;
    background: #e4f8f0;
    border: 1px solid #a3e0c9;
    color: #008060;
    font-size: 13px;
    line-height: 1.6;
    font-weight: 600;
  }

  .vip-alert-check-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 0;
    border-bottom: 1px solid #e2e4ed;
    font-size: 13px;
    color: #4a4a4a;
  }
  .vip-alert-check-item:last-child { border-bottom: 0; }

  .vip-bottom-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.4fr) minmax(320px, 0.85fr);
    gap: 20px;
    align-items: start;
  }

  .vip-quick-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
  .vip-quick-link { display: flex; justify-content: space-between; align-items: center; gap: 12px; border: 1px solid var(--vip-border); border-radius: 16px; padding: 18px; text-decoration: none; color: inherit; background: white; box-shadow: var(--vip-shadow); transition: all 0.15s ease; }
  .vip-quick-link:hover { border-color: #a8abaf; transform: translateY(-1px); }
  .vip-quick-link strong { display: block; font-size: 14px; font-weight: 800; color: var(--vip-text); }
  .vip-quick-link span:not(.vip-quick-arrow) { display: block; margin-top: 4px; color: var(--vip-muted); font-size: 12px; }
  .vip-quick-arrow { font-size: 18px; color: #008060; font-weight: 800; }

  .vip-health { padding: 22px; }
  .vip-health h3 { margin: 0 0 14px; font-size: 18px; font-weight: 800; }
  .vip-health-row { display: flex; justify-content: space-between; gap: 12px; align-items: center; padding: 11px 0; border-bottom: 1px solid #f0f0f4; font-size: 13px; }
  .vip-health-row:last-child { border-bottom: 0; }
  .vip-health-label { display: flex; gap: 8px; align-items: center; color: var(--vip-muted); }
  .vip-health-dot { width: 8px; height: 8px; border-radius: 50%; }
  .vip-health-dot--success { background: #008060; }
  .vip-health-dot--warning { background: #d89a17; }
  .vip-health-dot--critical { background: #d32f2f; }

  @media (max-width: 980px) {
    .vip-setup-grid { grid-template-columns: repeat(2, 1fr); }
    .vip-main-grid, .vip-bottom-grid { grid-template-columns: 1fr; }
    .vip-quick-grid { grid-template-columns: 1fr; }
  }
`;

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();

  const themeSyncFetcher = useFetcher<{
    success?: boolean;
    message?: string;
  }>();

  const statusFetcher = useFetcher<DashboardStatus>();

  const themeSyncing = themeSyncFetcher.state !== "idle";

  const { entitlement } = data;

  /*
   * =========================================================
   * LIVE SETUP WATCHER
   * =========================================================
   *
   * Không dùng navigate() để polling.
   * Chỉ fetch dữ liệu trạng thái, không reload Dashboard.
   * Vì vậy scroll position của người dùng không bị ảnh hưởng.
   */

  useEffect(() => {
    const loadStatus = () => {
      statusFetcher.load("/app/dashboard-status");
    };

    // Lấy trạng thái ngay khi Dashboard mở.
    loadStatus();

    // Theo dõi toàn bộ 5 task.
    const timer = window.setInterval(loadStatus, 5000);

    return () => {
      window.clearInterval(timer);
    };
  }, []);

  /*
   * Sau khi Sync Theme hoàn tất,
   * kiểm tra lại trạng thái ngay thay vì chờ 5 giây.
   */
  useEffect(() => {
    if (
      themeSyncFetcher.state === "idle" &&
      themeSyncFetcher.data?.success === true
    ) {
      statusFetcher.load("/app/dashboard-status");
    }
  }, [
    themeSyncFetcher.state,
    themeSyncFetcher.data?.success,
  ]);

  /*
   * =========================================================
   * LIVE STATUS
   * =========================================================
   */

  const live = statusFetcher.data;

  /*
   * Nếu watcher chưa trả dữ liệu,
   * dùng trạng thái ban đầu từ Dashboard loader.
   */
  const subscriptionReady =
    live?.subscription.ready ??
    entitlement.active;

  const catalogStatus =
    live?.catalog.status ??
    (data.catalogJob?.status ?? "NOT_STARTED").toUpperCase();

  const catalogBusy =
    live?.catalog.busy ??
    (
      ["PENDING", "PROCESSING", "RUNNING"].includes(catalogStatus) ||
      data.queue.pending > 0 ||
      data.queue.processing > 0
    );

  const catalogReady =
    live?.catalog.ready ??
    (
      catalogStatus === "DONE" &&
      !Boolean(data.catalogJob?.lastError) &&
      data.queue.failed === 0 &&
      data.queue.pending === 0 &&
      data.queue.processing === 0
    );

  const catalogFailed =
    live?.catalog.failed ??
    (
      catalogStatus === "FAILED" ||
      Boolean(data.catalogJob?.lastError) ||
      data.queue.failed > 0
    );

  const searchSettingReady =
    live?.aiEngine.ready ??
    data.settings.aiSearchEnabled;

  const embedReady =
    live?.appEmbed.ready ??
    data.theme.appEmbedEnabled === true;

  const themeReady =
    live?.themeMap.ready ??
    data.theme.integrationReady;

  const isBackgroundSyncing =
    catalogBusy;

  /*
   * Đây là trạng thái thật của 5 task.
   */
  const readinessSteps = [
    subscriptionReady,
    catalogReady && !catalogFailed,
    searchSettingReady,
    embedReady,
    themeReady,
  ];

  const readinessDone =
    readinessSteps.filter(Boolean).length;

  const isFullyReady =
    live?.allReady ??
    readinessDone === readinessSteps.length;

  /*
   * Chỉ hiện Live Setup khi:
   *
   * - Có task chưa hoàn thành
   * - Hoặc đang đồng bộ
   * - Hoặc có lỗi / cần hành động
   */
  const showLiveSetup = !isFullyReady;

  /*
   * Queue state dùng cho System Health bên dưới.
   */
  const queueHasFailures =
    live?.catalog.failed ??
    data.queue.failed > 0;

  const isQueueBusy =
    live?.catalog.busy ??
    (
      data.queue.pending > 0 ||
      data.queue.processing > 0
    );

  const searchRemaining = remaining(
    entitlement.limits.searchLimit,
    entitlement.usage.searchCount,
  );
  const searchProgress = percentage(
    entitlement.usage.searchCount,
    entitlement.limits.searchLimit,
  );
  const productProgress = percentage(
    entitlement.indexedProducts,
    entitlement.limits.productLimit,
  );

  const impact = data.searchImpact;
  const current7dSeries = impact.series.slice(-7);
  const previous7dSeries = impact.series.slice(-14, -7);
  const current7dSearches = current7dSeries.reduce((sum, item) => sum + item.searches, 0);
  const previous7dSearches = previous7dSeries.reduce((sum, item) => sum + item.searches, 0);
  const current7dClickedSearches = current7dSeries.reduce((sum, item) => sum + item.clickedSearches, 0);
  const current7dAbnormalSearches = current7dSeries.reduce((sum, item) => sum + item.abnormalSearches, 0);
  const current7dCtr = impact.comparison.current7dCtr;
  const previous7dCtr = impact.comparison.previous7dCtr;
  const searchVolumeDeltaPercent =
    previous7dSearches > 0
      ? ((current7dSearches - previous7dSearches) / previous7dSearches) * 100
      : null;

  const queueState: UiState = queueHasFailures
    ? "critical"
    : isQueueBusy
      ? "warning"
      : "success";

  return (
    <div style={{ width: "100%", padding: "0 24px 60px 24px", boxSizing: "border-box" }}>
      <style>{dashboardCss}</style>

      <div className="vip-shell">
              {showLiveSetup ? (
                <section className="vip-setup-box">
          <div className="vip-setup-head">
            <div>
              <div className="vip-setup-title">
                <span className="vip-setup-icon">✦</span>
                <div>
                  <h3>Live Setup</h3>
                  <span>Production readiness</span>
                </div>
              </div>
            </div>
            <StatusPill state={isFullyReady ? "success" : "warning"}>
              {`${readinessDone}/5 Completed`}
            </StatusPill>
          </div>

          <div className="vip-setup-grid">
            {/* Step 1 */}
            <ReadinessStep
              index={1}
              title="Subscription"
              state={entitlement.active ? "success" : "warning"}
              status={entitlement.active ? "Active" : "Action Needed"}
              action={{ label: "Billing →", href: "/app/billing" }}
            />

            {/* Step 2 */}
            <ReadinessStep
              index={2}
              title="Catalog Index"
              state={
                catalogFailed
                  ? "critical"
                  : catalogReady
                    ? "success"
                    : "warning"
              }
              status={
                catalogFailed
                  ? "Error"
                  : catalogReady
                    ? "Synced"
                    : "Syncing"
              }
              action={{ label: "Open Sync →", href: "/app/catalog-sync" }}
            />

            {/* Step 3 */}
            <ReadinessStep
              index={3}
              title="AI Engine"
              state={searchSettingReady ? "success" : "neutral"}
              status={searchSettingReady ? "Enabled" : "Disabled"}
              action={{ label: "Settings →", href: "/app/settings" }}
            />

            {/* Step 4 */}
            <ReadinessStep
              index={4}
              title="App Embed"
              state={embedReady ? "success" : "warning"}
              status={embedReady ? "Enabled" : "Disabled"}
              action={
                data.appEmbedUrl
                  ? { label: "Theme Editor →", href: data.appEmbedUrl, targetTop: true }
                  : { label: "Settings →", href: "/app/settings" }
              }
            />

            {/* Step 5 */}
            <ReadinessStep
              index={5}
              title="Theme Map"
              state={
                themeSyncFetcher.data?.success === false
                  ? "critical"
                  : themeReady
                    ? "success"
                    : "warning"
              }
              status={
                themeSyncing
                  ? "Syncing"
                  : themeReady
                    ? "Ready"
                    : "Needs Check"
              }
              actionNode={
                <themeSyncFetcher.Form method="post" action="/app/settings">
                  <input type="hidden" name="intent" value="sync_theme_map" />
                  <button
                    type="submit"
                    className="vip-check-button"
                    disabled={themeSyncing}
                  >
                    {themeSyncing ? "Syncing..." : "Sync Theme"}
                  </button>
                </themeSyncFetcher.Form>
              }
            />
          </div>
                </section>
          ) : null}


        {/* BỐ CỤC CHÍNH GRID CÂN BẰNG CHIỀU CAO */}
        <section className="vip-main-grid">
          {/* CỘT TRÁI: METRICS & CHART */}
          <div className="vip-left-col">
            <div className="vip-two-metrics">
              <MetricCard
                eyebrow="Indexed Products"
                value={formatUsage(entitlement.indexedProducts, entitlement.limits.productLimit)}
                detail="Products ready for AI vector ranking."
                progress={productProgress}
                accent="violet"
                isSyncing={isBackgroundSyncing}
              />
              <MetricCard
                eyebrow="AI Searches"
                value={formatUsage(entitlement.usage.searchCount, entitlement.limits.searchLimit)}
                detail={
                  searchRemaining === null
                    ? "Unlimited plan active."
                    : `${searchRemaining.toLocaleString("en-US")} searches left this cycle.`
                }
                progress={searchProgress}
                accent="cyan"
              />
            </div>

            <div className="vip-panel vip-impact">
              <div className="vip-impact-head">
                <div>
                  <h3>Search Performance</h3>
                  <span style={{ fontSize: 13, color: "#5c6270" }}>
                    Compare searches, clicks, and abnormal queries over the last 7 days.
                  </span>
                </div>
                <StatusPill state={current7dSearches > 0 ? "success" : "neutral"}>
                  {`${current7dSearches.toLocaleString("en-US")} searches · 7d`}
                </StatusPill>
              </div>

              <div className="vip-impact-kpis">
                <div className="vip-impact-kpi">
                  <span>AI Searches</span>
                  <strong>{current7dSearches.toLocaleString("en-US")}</strong>
                  <small>
                    {previous7dSearches > 0
                      ? `${signedPct(searchVolumeDeltaPercent)} vs prior 7d`
                      : `Prior 7d: ${previous7dSearches}`}
                  </small>
                </div>

                <div className="vip-impact-kpi">
                  <span>Clicked Searches</span>
                  <strong>{current7dClickedSearches.toLocaleString("en-US")}</strong>
                  <small>
                    {current7dSearches > 0
                      ? `${Math.max(0, current7dSearches - current7dClickedSearches)} no click`
                      : "No activity"}
                  </small>
                </div>

                <div className="vip-impact-kpi">
                  <span>CTR Rate</span>
                  <strong>{fmtPct(current7dCtr)}</strong>
                  <small>Prior 7d: {fmtPct(previous7dCtr)}</small>
                </div>

                <div className="vip-impact-kpi">
                  <span>Anomalies</span>
                  <strong>{current7dAbnormalSearches.toLocaleString("en-US")}</strong>
                  <small>Zero results or low similarity</small>
                </div>
              </div>

              <SearchPerformanceChart series={impact.series} />
            </div>
          </div>

          {/* CỘT PHẢI: SEARCH ALERTS */}
          <aside className="vip-panel vip-alerts">
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h3>Search Alerts</h3>
                <StatusPill state={impact.alerts.length > 0 ? "warning" : "success"}>
                  {impact.alerts.length > 0 ? `${impact.alerts.length} Issues` : "Healthy"}
                </StatusPill>
              </div>
              <div style={{ fontSize: 13, color: "#5c6270", marginTop: 4 }}>
                Highlights recurring search anomalies across your store.
              </div>

              {impact.alerts.length ? (
                <div className="vip-alert-list">
                  {impact.alerts.map((alert, index) => (
                    <div
                      className={`vip-alert vip-alert--${alert.severity.toLowerCase()}`}
                      key={`${alert.type}-${alert.query ?? "global"}-${index}`}
                    >
                      <span className="vip-alert__dot" />
                      <div>
                        <div className="vip-alert__title">
                          <span>{AlertTypeLabel(alert.type)}</span>
                          <span
                            className={`vip-pill vip-pill--${
                              alert.severity === "HIGH" ? "critical" : "warning"
                            }`}
                          >
                            {alert.severity}
                          </span>
                        </div>
                        {alert.query ? (
                          <div className="vip-alert__query">“{alert.query}”</div>
                        ) : null}
                        <div className="vip-alert__detail">{alert.detail}</div>
                      </div>
                      <div className="vip-alert__count">
                        {alert.count.toLocaleString("en-US")}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="vip-alerts-healthy-box">
                  <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 6 }}>
                    ✓ No recurring search anomalies detected in the last {impact.windowDays} days.
                  </div>
                  <p style={{ margin: 0, fontSize: 12, fontWeight: 400, color: "#006e52" }}>
                    Your store search experience is running smooth. Zero-result and low-similarity queries are monitored automatically.
                  </p>
                </div>
              )}
            </div>

            <div style={{ borderTop: "1px solid #f0f0f4", paddingTop: 16, marginTop: 20 }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: "#5c6270", textTransform: "uppercase", marginBottom: 10 }}>
                📊 Search Quality Health Monitor
              </div>
              <div className="vip-alert-check-item">
                <span style={{ color: "#008060", fontWeight: "bold" }}>✓</span>
                <span>Zero-Result Query Prevention</span>
              </div>
              <div className="vip-alert-check-item">
                <span style={{ color: "#008060", fontWeight: "bold" }}>✓</span>
                <span>Low-Similarity AI Fallback</span>
              </div>
              <div className="vip-alert-check-item">
                <span style={{ color: "#008060", fontWeight: "bold" }}>✓</span>
                <span>Click-Through Rate (CTR) Tracking</span>
              </div>
            </div>
          </aside>
        </section>

        {/* KHỐI DƯỚI CÙNG: QUICK LINKS VÀ SYSTEM HEALTH */}
        <section className="vip-bottom-grid">
          <div className="vip-quick-grid">
            <QuickLink
              title="Catalog"
              detail="Monitor catalog sync jobs and vector index."
              href="/app/catalog-sync"
            />
            <QuickLink
              title="Search Analytics"
              detail="Track CTR, clicks, and query quality."
              href="/app/search-analytics"
            />
            <QuickLink
              title="Usage"
              detail="Monitor quotas and usage logs."
              href="/app/usage"
            />
            <QuickLink
              title="Plans & Billing"
              detail="Manage AI Search subscription plans."
              href="/app/billing"
            />
            <QuickLink
              title="Settings"
              detail="Configure search language and AI limits."
              href="/app/settings"
            />
            <QuickLink
              title="Theme Integration"
              detail={
                data.theme.themeName
                  ? `Active theme · ${data.theme.themeName}`
                  : "Check App Embed status."
              }
              href={data.appEmbedUrl ?? "/app/settings"}
              targetTop={Boolean(data.appEmbedUrl)}
            />
          </div>

          <div className="vip-panel vip-health">
            <h3>System Health</h3>
            <HealthRow
              label="AI Search"
              value={entitlement.searchAllowed && searchSettingReady ? "Online" : "Standby"}
              state={entitlement.searchAllowed && searchSettingReady ? "success" : "warning"}
            />
            <HealthRow
              label="Catalog"
              value={catalogReady ? "Synced" : catalogStatus}
              state={catalogFailed ? "critical" : catalogReady ? "success" : "warning"}
            />
            <HealthRow
              label="Theme Map"
              value={themeReady ? "Compatible" : "Check Needed"}
              state={themeReady ? "success" : "warning"}
            />
            <HealthRow
              label="App Embed"
              value={embedReady ? "Enabled" : "Disabled"}
              state={embedReady ? "success" : "warning"}
            />
            <HealthRow
              label="Queue Status"
              value={`${data.queue.pending} pending · ${data.queue.processing} active`}
              state={queueState}
            />
          </div>
        </section>
      </div>
    </div>
  );
}