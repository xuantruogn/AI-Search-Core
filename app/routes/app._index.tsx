import { useEffect } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { Link, useFetcher, useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import { getShopEntitlement } from "../services/commerce/entitlement.server";
import { getProductSyncQueueStats } from "../services/products/product-sync-job.server";
import { getLatestCatalogSyncJob } from "../services/catalog/catalog-sync-job.server";
import { getShopifyPricingPlansUrl } from "../services/billing/shopify-app-pricing.server";
import { getThemeAppEmbedDeepLink } from "../services/theme/app-embed.server";
import { getThemeIntegrationStatus } from "../services/theme/theme-integration.server";
import { getShopSettings } from "../services/commerce/shop-registry.server";
import { getSearchImpactSnapshot } from "../services/search/search-impact.server";

type UiState = "success" | "warning" | "critical" | "neutral";

type DashboardStatus = {
  updatedAt: string;
  subscription: { ready: boolean; status: string };
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
  aiEngine: { ready: boolean; status: string };
  appEmbed: { ready: boolean; status: string; themeName: string | null };
  themeMap: { ready: boolean; status: string };
  allReady: boolean;
};

type ThemeSummary = {
  integrationStatus: string;
  themeMapReady: boolean;
  appEmbedEnabled: boolean | null;
  appEmbedReason: string | null;
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

function normalizeThemeIntegration(value: unknown): ThemeSummary {
  const integration = objectValue(value);
  const appEmbed = objectValue(integration.appEmbed);
  const themeMap = objectValue(integration.themeMap);

  const status =
    stringValue(integration.status) ??
    stringValue(integration.reason) ??
    "UNKNOWN";

  // The backend already applies the Theme Map V4 capability rules.
  // Do not re-infer readiness from loose status strings in the UI.
  const themeMapReady = integration.themeMapReady === true;

  const renderStrategy =
    stringValue(integration.renderStrategy) ??
    stringValue(themeMap.renderStrategy) ??
    stringValue(integration.rendererMode) ??
    null;

  return {
    integrationStatus: status,
    themeMapReady,
    appEmbedEnabled: booleanValue(appEmbed.enabled),
    appEmbedReason: stringValue(appEmbed.reason),
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
    pricingUrl: getShopifyPricingPlansUrl(session.shop),
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

function percent(part: number, total: number) {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}

function stateLabel(state: UiState) {
  if (state === "success") return "Operational";
  if (state === "warning") return "Needs attention";
  if (state === "critical") return "Action required";
  return "Paused";
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
}: {
  eyebrow: string;
  value: string;
  detail: string;
  progress?: number | null;
  accent?: "violet" | "cyan" | "green" | "amber";
}) {
  return (
    <div className={`vip-metric vip-metric--${accent}`}>
      <div className="vip-metric__top">
        <span className="vip-metric__eyebrow">{eyebrow}</span>
        <span className="vip-metric__spark" aria-hidden="true" />
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

function ReadinessItem({
  index,
  title,
  detail,
  state,
  status,
  action,
  actionNode,
}: {
  index: number;
  title: string;
  detail: string;
  state: UiState;
  status: string;
  action?: { label: string; href: string; targetTop?: boolean };
  actionNode?: React.ReactNode;
}) {
  return (
    <div className="vip-check-row">
      <div className={`vip-check-index vip-check-index--${state}`}>{index}</div>
      <div className="vip-check-copy">
        <div className="vip-check-title-row">
          <strong>{title}</strong>
          <StatusPill state={state}>{status}</StatusPill>
        </div>
        <div className="vip-check-detail">{detail}</div>
      </div>
      {actionNode ? (
        <div className="vip-check-action">{actionNode}</div>
      ) : action ? (
        <div className="vip-check-action">
          {action.targetTop ? (
            <a href={action.href} target="_top" rel="noreferrer">
              {action.label}
            </a>
          ) : (
            <Link to={action.href}>{action.label}</Link>
          )}
        </div>
      ) : null}
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

function Notice({
  state,
  title,
  children,
}: {
  state: UiState;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`vip-notice vip-notice--${state}`}>
      <div className="vip-notice__icon" aria-hidden="true">
        {state === "critical" ? "!" : state === "warning" ? "i" : "✓"}
      </div>
      <div>
        <strong>{title}</strong>
        <div>{children}</div>
      </div>
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
    <a
      className="vip-quick-link"
      href={href}
      target="_top"
      rel="noreferrer"
    >
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
  const height = 220;
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
    padLeft +
    (index / Math.max(1, visible.length - 1)) * plotWidth;
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
        aria-label="Total AI searches, searches with clicks, and search anomalies over the last 7 days"
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
    --vip-shadow: 0 12px 36px rgba(26, 22, 60, .06);
    display: grid;
    gap: 24px;
    color: var(--vip-text);
    padding-bottom: 32px;
    width: 100%;
    box-sizing: border-box;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }

  .vip-hero {
    position: relative;
    overflow: hidden;
    min-height: 240px;
    border-radius: 24px;
    padding: 32px;
    color: white;
    background:
      radial-gradient(circle at 82% 15%, rgba(117, 235, 255, .3), transparent 30%),
      radial-gradient(circle at 70% 92%, rgba(173, 121, 255, .3), transparent 38%),
      linear-gradient(135deg, #16132e 0%, #31266f 52%, #155e75 118%);
    box-shadow: 0 20px 60px rgba(47, 38, 110, .25);
  }

  .vip-hero:after {
    content: "";
    position: absolute;
    inset: 0;
    background-image: linear-gradient(rgba(255,255,255,.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.04) 1px, transparent 1px);
    background-size: 36px 36px;
    mask-image: linear-gradient(to bottom left, #000, transparent 70%);
    pointer-events: none;
  }

  .vip-hero__content {
    position: relative;
    z-index: 2;
    display: grid;
    grid-template-columns: minmax(0, 1.6fr) minmax(280px, .7fr);
    gap: 32px;
    align-items: stretch;
  }

  .vip-kicker {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 16px;
    color: rgba(255,255,255,.85);
    font-size: 13px;
    font-weight: 800;
    letter-spacing: .12em;
    text-transform: uppercase;
  }

  .vip-kicker:before {
    content: "";
    width: 28px;
    height: 2px;
    background: rgba(255,255,255,.6);
  }

  .vip-hero h2 {
    margin: 0;
    max-width: 820px;
    font-size: clamp(32px, 4.2vw, 50px);
    line-height: 1.08;
    letter-spacing: -.03em;
    font-weight: 800;
  }

  .vip-hero__subtitle {
    max-width: 760px;
    margin: 16px 0 24px;
    color: rgba(255,255,255,.88);
    font-size: 16px;
    line-height: 1.6;
  }

  .vip-hero__meta {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  .vip-hero__meta span {
    border: 1px solid rgba(255,255,255,.18);
    background: rgba(255,255,255,.1);
    border-radius: 999px;
    padding: 8px 14px;
    color: rgba(255,255,255,.92);
    font-size: 13px;
    font-weight: 600;
    backdrop-filter: blur(10px);
  }

  .vip-readiness-card {
    position: relative;
    z-index: 2;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    min-height: 190px;
    border: 1px solid rgba(255,255,255,.2);
    border-radius: 22px;
    padding: 24px;
    background: rgba(255,255,255,.12);
    backdrop-filter: blur(16px);
  }

  .vip-readiness-card__top {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    align-items: flex-start;
  }

  .vip-readiness-card__label {
    color: rgba(255,255,255,.8);
    font-size: 13px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: .08em;
  }

  .vip-readiness-card__score {
    margin-top: 8px;
    font-size: 42px;
    font-weight: 800;
    letter-spacing: -.04em;
  }

  .vip-ring {
    --value: 100;
    width: 76px;
    height: 76px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: conic-gradient(#79f2c0 calc(var(--value) * 1%), rgba(255,255,255,.15) 0);
  }

  .vip-ring:after {
    content: "";
    width: 60px;
    height: 60px;
    border-radius: 50%;
    background: #282255;
    box-shadow: inset 0 0 0 1px rgba(255,255,255,.1);
  }

  .vip-readiness-card__footer {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: flex-end;
    color: rgba(255,255,255,.82);
    font-size: 13px;
    line-height: 1.5;
  }

  .vip-readiness-card__footer strong {
    color: white;
    font-size: 14px;
  }

  .vip-pill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    width: fit-content;
    border-radius: 999px;
    padding: 7px 12px;
    font-size: 12px;
    font-weight: 700;
    white-space: nowrap;
  }

  .vip-pill__dot { width: 8px; height: 8px; border-radius: 50%; }
  .vip-pill--success { background: #e4f8f0; color: #008060; }
  .vip-pill--success .vip-pill__dot { background: #008060; box-shadow: 0 0 0 4px rgba(0,128,96,.15); }
  .vip-pill--warning { background: #fff6df; color: #8a5b00; }
  .vip-pill--warning .vip-pill__dot { background: #d89a17; box-shadow: 0 0 0 4px rgba(216,154,23,.15); }
  .vip-pill--critical { background: #ffebe9; color: #d32f2f; }
  .vip-pill--critical .vip-pill__dot { background: #d32f2f; box-shadow: 0 0 0 4px rgba(211,47,47,.15); }
  .vip-pill--neutral { background: #f1f2f3; color: #5c6270; }
  .vip-pill--neutral .vip-pill__dot { background: #8c9196; }

  .vip-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }

  .vip-action {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 42px;
    border-radius: 12px;
    padding: 0 18px;
    font-size: 14px;
    font-weight: 700;
    text-decoration: none;
    transition: transform .18s ease, box-shadow .18s ease, background .18s ease;
  }

  .vip-action:hover { transform: translateY(-1px); }
  .vip-action--primary { background: white; color: #1e1b4b; box-shadow: 0 10px 24px rgba(0,0,0,.15); }
  .vip-action--ghost { border: 1px solid rgba(255,255,255,.24); color: white; background: rgba(255,255,255,.12); backdrop-filter: blur(8px); }

  .vip-metrics {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 16px;
  }

  .vip-metric {
    position: relative;
    overflow: hidden;
    min-height: 160px;
    border: 1px solid var(--vip-border);
    border-radius: 20px;
    padding: 22px;
    background: var(--vip-panel);
    box-shadow: var(--vip-shadow);
  }

  .vip-metric:after {
    content: "";
    position: absolute;
    right: -30px;
    bottom: -40px;
    width: 130px;
    height: 130px;
    border-radius: 50%;
    opacity: .12;
  }

  .vip-metric--violet:after { background: #7357ff; }
  .vip-metric--cyan:after { background: #28b8d5; }
  .vip-metric--green:after { background: #30ad70; }
  .vip-metric--amber:after { background: #e6a631; }

  .vip-metric__top { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
  .vip-metric__eyebrow { color: #5c6270; font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; }
  .vip-metric__spark { width: 8px; height: 8px; border-radius: 50%; background: currentColor; opacity: .65; box-shadow: 0 0 0 5px rgba(120,110,190,.12); }
  .vip-metric__value { margin-top: 16px; font-size: 32px; font-weight: 800; letter-spacing: -.03em; color: var(--vip-text); }
  .vip-metric__detail { margin-top: 8px; color: var(--vip-muted); font-size: 13px; line-height: 1.5; }

  .vip-progress { height: 6px; margin-top: 16px; border-radius: 999px; background: #eef0f4; overflow: hidden; }
  .vip-progress span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #6f5cf5, #28b8d5); }

  .vip-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.6fr) minmax(320px, .8fr);
    gap: 20px;
    align-items: start;
  }

  .vip-panel {
    border: 1px solid var(--vip-border);
    border-radius: 22px;
    background: var(--vip-panel);
    box-shadow: var(--vip-shadow);
    overflow: hidden;
  }

  .vip-panel__head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 20px;
    padding: 24px 26px 18px;
    border-bottom: 1px solid #f0f0f4;
  }

  .vip-panel__head h3 { margin: 0; font-size: 19px; font-weight: 800; letter-spacing: -.02em; }
  .vip-panel__head p { margin: 6px 0 0; color: var(--vip-muted); font-size: 13px; line-height: 1.5; }
  .vip-panel__body { padding: 6px 26px 12px; }

  .vip-check-row {
    display: grid;
    grid-template-columns: 40px minmax(0,1fr) auto;
    gap: 16px;
    align-items: center;
    padding: 18px 0;
    border-bottom: 1px solid #f0f0f4;
  }

  .vip-check-row:last-child { border-bottom: 0; }
  .vip-check-index { width: 34px; height: 34px; border-radius: 12px; display: grid; place-items: center; font-size: 14px; font-weight: 800; }
  .vip-check-index--success { color: #008060; background: #e4f8f0; }
  .vip-check-index--warning { color: #8a5b00; background: #fff6df; }
  .vip-check-index--critical { color: #d32f2f; background: #ffebe9; }
  .vip-check-index--neutral { color: #5c6270; background: #f1f2f3; }
  .vip-check-title-row { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
  .vip-check-title-row strong { font-size: 15px; font-weight: 700; color: var(--vip-text); }
  .vip-check-detail { margin-top: 6px; color: var(--vip-muted); font-size: 13px; line-height: 1.5; }
  .vip-check-action { font-size: 13px; font-weight: 700; white-space: nowrap; }
  .vip-check-action a { color: #4f46e5; text-decoration: none; }
  .vip-check-action a:hover { text-decoration: underline; }
  .vip-check-button {
    appearance: none;
    border: 0;
    padding: 0;
    background: transparent;
    color: #4f46e5;
    font: inherit;
    font-weight: 700;
    font-size: 13px;
    text-decoration: underline;
    text-underline-offset: 3px;
    cursor: pointer;
  }
  .vip-check-button:hover { color: #3730a3; }
  .vip-check-button:disabled { color: #8c9196; cursor: wait; text-decoration: none; }

  .vip-side-stack { display: grid; gap: 20px; }
  .vip-health { padding: 24px; }
  .vip-health h3 { margin: 0 0 4px; font-size: 19px; font-weight: 800; }
  .vip-health > p { margin: 0 0 18px; color: var(--vip-muted); font-size: 13px; }
  .vip-health-row { display: flex; justify-content: space-between; gap: 16px; align-items: center; padding: 13px 0; border-bottom: 1px solid #f0f0f4; font-size: 13px; }
  .vip-health-row:last-child { border-bottom: 0; }
  .vip-health-row strong { font-size: 14px; font-weight: 700; color: var(--vip-text); }
  .vip-health-label { display: flex; gap: 10px; align-items: center; color: var(--vip-muted); font-size: 13px; }
  .vip-health-dot { width: 9px; height: 9px; border-radius: 50%; }
  .vip-health-dot--success { background: #008060; }
  .vip-health-dot--warning { background: #d89a17; }
  .vip-health-dot--critical { background: #d32f2f; }
  .vip-health-dot--neutral { background: #8c9196; }

  .vip-intel {
    position: relative;
    overflow: hidden;
    padding: 24px;
    background: linear-gradient(145deg, #f8f7ff, #f3fbff);
  }
  .vip-intel:after { content: ""; position: absolute; width: 160px; height: 160px; border-radius: 50%; right: -40px; top: -60px; background: linear-gradient(135deg,#7c62ff,#49c2d7); opacity: .15; }
  .vip-intel__icon { width: 42px; height: 42px; border-radius: 14px; display: grid; place-items: center; background: #241d4f; color: white; font-weight: 800; font-size: 15px; box-shadow: 0 10px 24px rgba(36,29,79,.2); }
  .vip-intel h3 { margin: 18px 0 6px; font-size: 19px; font-weight: 800; }
  .vip-intel p { margin: 0 0 16px; color: var(--vip-muted); font-size: 13px; line-height: 1.6; }
  .vip-intel a { color: #4f46e5; font-size: 13px; font-weight: 700; text-decoration: none; }

  .vip-quick-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 16px; }
  .vip-quick-link { display: flex; justify-content: space-between; align-items: center; gap: 16px; border: 1px solid var(--vip-border); border-radius: 20px; padding: 20px 22px; text-decoration: none; color: inherit; background: white; box-shadow: var(--vip-shadow); transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease; }
  .vip-quick-link:hover { transform: translateY(-2px); box-shadow: 0 16px 40px rgba(38,32,72,.1); border-color: #c7c3e0; }
  .vip-quick-link strong { display: block; font-size: 15px; font-weight: 800; color: var(--vip-text); }
  .vip-quick-link span:not(.vip-quick-arrow) { display: block; margin-top: 6px; color: var(--vip-muted); font-size: 12px; line-height: 1.45; }
  .vip-quick-arrow { font-size: 20px; color: #4f46e5; font-weight: 800; }

  .vip-notice { display: grid; grid-template-columns: 36px 1fr; gap: 14px; align-items: start; border-radius: 18px; padding: 16px 20px; font-size: 13px; line-height: 1.55; }
  .vip-notice__icon { width: 30px; height: 30px; border-radius: 999px; display: grid; place-items: center; font-weight: 800; font-size: 14px; }
  .vip-notice strong { display: block; margin-bottom: 4px; font-size: 14px; }
  .vip-notice--critical { background: #ffebe9; color: #d32f2f; border: 1px solid #f8b4b4; }
  .vip-notice--critical .vip-notice__icon { background: #f8b4b4; }
  .vip-notice--warning { background: #fff6df; color: #8a5b00; border: 1px solid #f3d489; }
  .vip-notice--warning .vip-notice__icon { background: #f3d489; }
  .vip-notice--success { background: #e4f8f0; color: #008060; border: 1px solid #a3e0c9; }
  .vip-notice--success .vip-notice__icon { background: #a3e0c9; }
  .vip-notice--neutral { background: #f1f2f3; color: #5c6270; border: 1px solid #e1e3e5; }

  .vip-analytics-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.55fr) minmax(330px, .75fr);
    gap: 20px;
    align-items: stretch;
  }

  .vip-impact, .vip-alerts { padding: 24px; }

  .vip-impact-head {
    display: flex;
    justify-content: space-between;
    gap: 18px;
    align-items: flex-start;
    margin-bottom: 20px;
  }

  .vip-impact-head h3, .vip-alerts h3 {
    margin: 0;
    font-size: 19px;
    font-weight: 800;
    letter-spacing: -.02em;
  }

  .vip-impact-head p, .vip-alerts__intro {
    margin: 6px 0 0;
    color: var(--vip-muted);
    font-size: 13px;
    line-height: 1.5;
  }

  .vip-impact-kpis {
    display: grid;
    grid-template-columns: repeat(4, minmax(0,1fr));
    gap: 12px;
    margin-bottom: 18px;
  }

  .vip-impact-kpi {
    border: 1px solid #e5e3f0;
    border-radius: 16px;
    padding: 15px 16px;
    background: linear-gradient(180deg,#fff,#fcfcfe);
  }

  .vip-impact-kpi span {
    display: block;
    color: #5c6270;
    font-size: 11px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: .08em;
  }

  .vip-impact-kpi strong {
    display: block;
    margin-top: 8px;
    font-size: 24px;
    font-weight: 800;
    letter-spacing: -.03em;
    color: var(--vip-text);
  }

  .vip-impact-kpi small {
    display: block;
    margin-top: 5px;
    color: var(--vip-muted);
    font-size: 11px;
    line-height: 1.45;
  }

  .vip-chart-shell {
    border: 1px solid #efedf6;
    border-radius: 20px;
    padding: 16px 14px 10px;
    background:
      radial-gradient(circle at 80% 0%, rgba(112,92,245,.08), transparent 30%),
      #fdfdff;
  }

  .vip-chart { display: block; width: 100%; height: 230px; }
  .vip-chart-label { font-size: 11px; fill: #8c9196; }
  .vip-chart-axis {
    display: flex;
    justify-content: space-between;
    padding: 0 9px 4px;
    color: #8c9196;
    font-size: 11px;
    font-weight: 600;
  }
  .vip-chart-axis--7 {
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
    padding: 0 18px 4px;
    text-align: center;
  }

  .vip-chart-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    padding: 2px 8px 10px;
    color: var(--vip-muted);
    font-size: 12px;
    font-weight: 700;
  }

  .vip-chart-legend span {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  .vip-chart-legend i {
    width: 10px;
    height: 10px;
    border-radius: 999px;
    display: inline-block;
  }

  .vip-chart-empty {
    min-height: 210px;
    display: grid;
    place-items: center;
    border: 1px dashed #dcd9e8;
    border-radius: 18px;
    color: #8c9196;
    font-size: 13px;
    background: #fcfcfe;
  }

  .vip-baseline-note {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    margin-top: 14px;
    padding: 13px 15px;
    border-radius: 14px;
    border: 1px solid #eef0f4;
    background: #fafafa;
    color: var(--vip-muted);
    font-size: 12px;
    line-height: 1.55;
  }

  .vip-alert-list {
    display: grid;
    gap: 12px;
    margin-top: 18px;
  }

  .vip-alert {
    display: grid;
    grid-template-columns: 10px minmax(0,1fr) auto;
    gap: 12px;
    align-items: start;
    padding: 14px 0;
    border-bottom: 1px solid #f0f0f4;
  }

  .vip-alert:last-child { border-bottom: 0; }

  .vip-alert__dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    margin-top: 6px;
  }

  .vip-alert--high .vip-alert__dot {
    background: #d32f2f;
    box-shadow: 0 0 0 5px rgba(211,47,47,.12);
  }

  .vip-alert--medium .vip-alert__dot {
    background: #d89a17;
    box-shadow: 0 0 0 5px rgba(216,154,23,.12);
  }

  .vip-alert__title {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    font-size: 13px;
    font-weight: 800;
  }

  .vip-alert__query {
    margin-top: 6px;
    color: var(--vip-text);
    font-size: 13px;
    font-weight: 700;
  }

  .vip-alert__detail {
    margin-top: 5px;
    color: var(--vip-muted);
    font-size: 12px;
    line-height: 1.5;
  }

  .vip-alert__count {
    min-width: 34px;
    border-radius: 999px;
    padding: 5px 9px;
    background: #f1f0fb;
    color: #4f46e5;
    font-size: 12px;
    font-weight: 800;
    text-align: center;
  }

  .vip-alert-empty {
    margin-top: 18px;
    padding: 20px;
    border-radius: 16px;
    background: #e4f8f0;
    border: 1px solid #a3e0c9;
    color: #008060;
    font-size: 13px;
    line-height: 1.55;
    font-weight: 600;
  }

  @media (max-width: 980px) {
    .vip-hero__content, .vip-grid, .vip-analytics-grid { grid-template-columns: 1fr; }
    .vip-metrics { grid-template-columns: repeat(2, minmax(0,1fr)); }
    .vip-impact-kpis { grid-template-columns: repeat(2, minmax(0,1fr)); }
    .vip-quick-grid { grid-template-columns: 1fr; }
  }

  @media (max-width: 640px) {
    .vip-hero { padding: 24px; border-radius: 20px; }
    .vip-metrics, .vip-impact-kpis { grid-template-columns: 1fr; }
    .vip-check-row { grid-template-columns: 36px minmax(0,1fr); }
    .vip-check-action { grid-column: 2; }
  }
`;

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();
  const themeSyncFetcher = useFetcher<{ success?: boolean; message?: string }>();
  const statusFetcher = useFetcher<DashboardStatus>();
  const themeSyncing = themeSyncFetcher.state !== "idle";
  const { entitlement } = data;

  useEffect(() => {
    const loadStatus = () => statusFetcher.load("/app/dashboard-status");
    loadStatus();
    const timer = window.setInterval(loadStatus, 5000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (
      themeSyncFetcher.state === "idle" &&
      themeSyncFetcher.data?.success === true
    ) {
      statusFetcher.load("/app/dashboard-status");
    }
  }, [themeSyncFetcher.state, themeSyncFetcher.data?.success]);

  const live = statusFetcher.data;
  const catalogStatus =
    live?.catalog.status ??
    (data.catalogJob?.status ?? "NOT_STARTED").toUpperCase();
  const catalogBusy =
    live?.catalog.busy ??
    (["PENDING", "PROCESSING", "RUNNING"].includes(catalogStatus) ||
      data.queue.pending > 0 ||
      data.queue.processing > 0);
  const catalogFailed =
    live?.catalog.failed ??
    (catalogStatus === "FAILED" ||
      Boolean(data.catalogJob?.lastError) ||
      (data.catalogJob?.productsFailed ?? 0) > 0 ||
      data.queue.failed > 0);
  const queueHasFailures = live?.catalog.failed ?? data.queue.failed > 0;
  const catalogReady =
    live?.catalog.ready ??
    (catalogStatus === "DONE" &&
      !catalogFailed &&
      data.queue.pending === 0 &&
      data.queue.processing === 0 &&
      data.queue.failed === 0);
  const subscriptionReady =
    live?.subscription.ready ??
    (entitlement.subscriptionStatus === "ACTIVE" && entitlement.plan !== "NONE");
  const embedReady =
    live?.appEmbed.ready ?? data.theme.appEmbedEnabled === true;
  const rendererReady =
    live?.themeMap.ready ?? data.theme.themeMapReady;
  const searchSettingReady =
    live?.aiEngine.ready ?? data.settings.aiSearchEnabled;

  let overall: { state: UiState; title: string; detail: string };

  if (!subscriptionReady) {
    overall = {
      state: "warning",
      title: "Activate Plan to Launch AI Search",
      detail: "Subscription is currently inactive. Storefront searches are safely handled by Shopify Native Search.",
    };
  } else if (catalogFailed || queueHasFailures) {
    overall = {
      state: "critical",
      title: "Action Required Before Launch",
      detail: "Catalog sync or product processing queue encountered errors. Safe fallback remains active.",
    };
  } else if (!catalogReady) {
    overall = {
      state: "warning",
      title: catalogBusy ? "Preparing Catalog Index" : "Catalog Index Not Ready",
      detail: "Preparing product catalog and vector embeddings for storefront search.",
    };
  } else if (!searchSettingReady) {
    overall = {
      state: "neutral",
      title: "AI Search Engine is Paused",
      detail: "Storefront is using default Shopify Search. You can re-enable AI Search in Settings anytime.",
    };
  } else if (!embedReady) {
    overall = {
      state: "warning",
      title: "One More Step: Enable App Embed",
      detail: "Backend is ready. Enable App Embed in Theme Editor to display AI search on storefront.",
    };
  } else if (!rendererReady) {
    overall = {
      state: "warning",
      title: "Pending Theme Integration Check",
      detail: "Active theme render path is awaiting confirmation. Safe fallback is active.",
    };
  } else if (!entitlement.searchAllowed) {
    overall = {
      state: "warning",
      title: "Shopify Native Search is Active",
      detail: entitlement.disabledReason
        ? `AI Search is temporarily paused: ${entitlement.disabledReason}.`
        : "AI Search is currently paused by entitlement limits.",
    };
  } else {
    overall = {
      state: "success",
      title: "AI Search is Operational",
      detail: "Catalog, subscription, and theme integration are 100% ready for production traffic.",
    };
  }

  const readinessSteps = [
    subscriptionReady,
    catalogReady && !catalogFailed && !queueHasFailures,
    searchSettingReady,
    embedReady,
    rendererReady,
  ];
  const readinessDone = readinessSteps.filter(Boolean).length;
  const readinessPercent = Math.round((readinessDone / readinessSteps.length) * 100);

  const searchRemaining = remaining(
    entitlement.limits.searchLimit,
    entitlement.usage.searchCount,
  );
  const searchProgress = percentage(
    entitlement.usage.searchCount,
    entitlement.limits.searchLimit,
  );
  const productProgress = percentage(
    entitlement.activeProductSlotsUsed,
    entitlement.limits.productLimit,
  );

  const fallbackCount = entitlement.usage.fallbackCount;
  const storefrontSearches = entitlement.usage.searchCount + fallbackCount;
  const impact = data.searchImpact;
  const current7dSeries = impact.series.slice(-7);
  const previous7dSeries = impact.series.slice(-14, -7);
  const current7dSearches = current7dSeries.reduce(
    (sum, item) => sum + item.searches,
    0,
  );
  const previous7dSearches = previous7dSeries.reduce(
    (sum, item) => sum + item.searches,
    0,
  );
  const current7dClickedSearches = current7dSeries.reduce(
    (sum, item) => sum + item.clickedSearches,
    0,
  );
  const current7dAbnormalSearches = current7dSeries.reduce(
    (sum, item) => sum + item.abnormalSearches,
    0,
  );
  const current7dCtr = impact.comparison.current7dCtr;
  const previous7dCtr = impact.comparison.previous7dCtr;
  const searchVolumeDeltaPercent =
    previous7dSearches > 0
      ? ((current7dSearches - previous7dSearches) / previous7dSearches) * 100
      : null;

  const aiCoverage = percent(entitlement.usage.searchCount, storefrontSearches);
  const fallbackRate = percent(fallbackCount, storefrontSearches);

  const queueState: UiState = queueHasFailures
    ? "critical"
    : data.queue.processing > 0 || data.queue.pending > 0
      ? "warning"
      : "success";

  return (
    <div style={{ width: "100%", padding: "0 24px 60px 24px", boxSizing: "border-box" }}>
      <style>{dashboardCss}</style>

      <div className="vip-shell">
        <section className="vip-hero">
          <div className="vip-hero__content">
            <div>
              <div className="vip-kicker">AI Search · Merchant Console</div>
              <StatusPill state={overall.state}>{stateLabel(overall.state)}</StatusPill>
              <h2 style={{ marginTop: 16 }}>{overall.title}</h2>
              <p className="vip-hero__subtitle">{overall.detail}</p>

              <div className="vip-actions">
                <Link className="vip-action vip-action--primary" to="/app/settings">
                  Configure search
                </Link>
                <Link className="vip-action vip-action--ghost" to="/app/search-analytics">
                  Search Analytics
                </Link>
                {data.pricingUrl ? (
                  <a
                    className="vip-action vip-action--ghost"
                    href={data.pricingUrl}
                    target="_top"
                  >
                    Plan & billing
                  </a>
                ) : null}
              </div>

              <div className="vip-hero__meta" style={{ marginTop: 22 }}>
                <span>{data.shop}</span>
                <span>{entitlement.planLabel}</span>
                <span>{entitlement.subscriptionStatus}</span>
                {data.theme.themeName ? <span>Theme · {data.theme.themeName}</span> : null}
              </div>
            </div>

            <div className="vip-readiness-card">
              <div className="vip-readiness-card__top">
                <div>
                  <div className="vip-readiness-card__label">Production readiness</div>
                  <div className="vip-readiness-card__score">{readinessPercent}%</div>
                </div>
                <div
                  className="vip-ring"
                  style={{ "--value": readinessPercent } as React.CSSProperties}
                  aria-label={`${readinessPercent}% production ready`}
                />
              </div>
              <div className="vip-readiness-card__footer">
                <div>
                  <strong>{readinessDone}/{readinessSteps.length} checks passed</strong>
                  <div style={{ marginTop: 4 }}>Live storefront safety remains protected by fallback.</div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {(catalogFailed || queueHasFailures) ? (
          <Notice state="critical" title="Catalog Sync Attention Required">
            Product queue has {data.queue.failed.toLocaleString("en-US")} FAILED jobs.
            {data.catalogJob?.lastError
              ? ` Latest catalog error: ${data.catalogJob.lastError}`
              : " Check background queue and logs before opening live traffic."}
          </Notice>
        ) : null}

        {entitlement.productLimitBlockedProducts > 0 ||
        entitlement.vectorQuotaBlockedProducts > 0 ? (
          <Notice state="warning" title="Product Capacity Restrictions Active">
            {entitlement.productLimitBlockedProducts > 0
              ? `${entitlement.productLimitBlockedProducts.toLocaleString("en-US")} products are excluded from AI Search by the product limit. `
              : ""}
            {entitlement.cachedProductLimitBlockedProducts > 0
              ? `${entitlement.cachedProductLimitBlockedProducts.toLocaleString("en-US")} of them retain cached vectors for fast recovery but remain non-searchable. `
              : ""}
            {entitlement.vectorQuotaBlockedProducts > 0
              ? `${entitlement.vectorQuotaBlockedProducts.toLocaleString("en-US")} products are pending vector quota.`
              : ""}
          </Notice>
        ) : null}

        <section className="vip-metrics">
          <MetricCard
            eyebrow="Active products"
            value={formatUsage(entitlement.activeProductSlotsUsed, entitlement.limits.productLimit)}
            detail={`${entitlement.cachedVectorCount.toLocaleString("en-US")} vectors cached · ${entitlement.cachedProductLimitBlockedProducts.toLocaleString("en-US")} cached & blocked from AI Search.`}
            progress={productProgress}
            accent="violet"
          />
          <MetricCard
            eyebrow="AI searches"
            value={formatUsage(entitlement.usage.searchCount, entitlement.limits.searchLimit)}
            detail={
              searchRemaining === null
                ? "Unlimited plan · executions logged."
                : `${searchRemaining.toLocaleString("en-US")} remaining in cycle.`
            }
            progress={searchProgress}
            accent="cyan"
          />
          <MetricCard
            eyebrow="AI coverage"
            value={`${aiCoverage}%`}
            detail={`${entitlement.usage.searchCount.toLocaleString("en-US")} / ${storefrontSearches.toLocaleString("en-US")} storefront searches processed by AI.`}
            accent="green"
          />
          <MetricCard
            eyebrow="Safe fallback"
            value={`${fallbackRate}%`}
            detail={`${fallbackCount.toLocaleString("en-US")} searches routed to safe Shopify Search fallback.`}
            accent="amber"
          />
        </section>

        <section className="vip-analytics-grid">
          <div className="vip-panel vip-impact">
            <div className="vip-impact-head">
              <div>
                <h3>Search performance</h3>
                <p>
                  Compare total searches, clicked searches, and anomalies over the last 7 days.
                </p>
              </div>
              <StatusPill state={current7dSearches > 0 ? "success" : "neutral"}>
                {`${current7dSearches.toLocaleString("en-US")} searches · 7 days`}
              </StatusPill>
            </div>

            <div className="vip-impact-kpis">
              <div className="vip-impact-kpi">
                <span>AI searches · 7 days</span>
                <strong>{current7dSearches.toLocaleString("en-US")}</strong>
                <small>
                  {previous7dSearches > 0
                    ? `${signedPct(searchVolumeDeltaPercent)} vs previous 7 days`
                    : `7 days prior: ${previous7dSearches.toLocaleString("en-US")}`}
                </small>
              </div>

              <div className="vip-impact-kpi">
                <span>Searches with click</span>
                <strong>{current7dClickedSearches.toLocaleString("en-US")}</strong>
                <small>
                  {current7dSearches > 0
                    ? `${Math.max(0, current7dSearches - current7dClickedSearches).toLocaleString("en-US")} searches without clicks`
                    : "No searches recorded in last 7 days"}
                </small>
              </div>

              <div className="vip-impact-kpi">
                <span>CTR · 7 days</span>
                <strong>{fmtPct(current7dCtr)}</strong>
                <small>7 days prior: {fmtPct(previous7dCtr)}</small>
              </div>

              <div className="vip-impact-kpi">
                <span>Search anomalies · 7 days</span>
                <strong>{current7dAbnormalSearches.toLocaleString("en-US")}</strong>
                <small>NO_RESULTS, LOW_SIMILARITY, or HIGH_SIMILARITY_NO_CLICK</small>
              </div>
            </div>

            <SearchPerformanceChart series={impact.series} />

            <div className="vip-baseline-note">
              <strong>7-day view:</strong>
              <span>
                All three trend lines use the same daily SearchLog. "Search anomalies"
                represent queries flagged with NO_RESULTS, LOW_SIMILARITY, or
                HIGH_SIMILARITY_NO_CLICK. Search Alerts highlight recurring issues over a {impact.windowDays}-day window.
              </span>
            </div>
          </div>

          <aside className="vip-panel vip-alerts">
            <h3>Search alerts</h3>
            <div className="vip-alerts__intro">
              Highlights recurring search anomalies; isolated query spikes are filtered to avoid alert fatigue.
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
              <div className="vip-alert-empty">
                No recurring search anomalies detected within the {impact.windowDays}-day window.
              </div>
            )}

            <div style={{ marginTop: 16 }}>
              <Link to="/app/search-analytics">Open Search Analytics →</Link>
            </div>
          </aside>
        </section>

        <section className="vip-grid">
          <div className="vip-panel">
            <div className="vip-panel__head">
              <div>
                <h3>Production readiness</h3>
                <p>5 essential layers required before accepting live traffic.</p>
              </div>
              <StatusPill state={readinessPercent === 100 ? "success" : "warning"}>
                {readinessPercent === 100 ? "Ready to launch" : `${readinessDone}/5 complete`}
              </StatusPill>
            </div>
            <div className="vip-panel__body">
              <ReadinessItem
                index={1}
                title="Subscription"
                state={subscriptionReady ? "success" : "warning"}
                status={subscriptionReady ? "Active" : "Needs activation"}
                detail={`${entitlement.planLabel} · ${entitlement.subscriptionStatus}`}
                action={
                  data.pricingUrl
                    ? { label: "Manage plan", href: data.pricingUrl, targetTop: true }
                    : undefined
                }
              />
              <ReadinessItem
                index={2}
                title="Catalog & vector index"
                state={
                  catalogFailed
                    ? "critical"
                    : catalogReady
                      ? "success"
                      : catalogBusy
                        ? "warning"
                        : "neutral"
                }
                status={
                  catalogFailed
                    ? "Error"
                    : catalogReady
                      ? "Synced"
                      : catalogBusy
                        ? "Syncing"
                        : "Not started"
                }
                detail={
                  data.catalogJob
                    ? `Processed ${data.catalogJob.productsProcessed.toLocaleString("en-US")} · Indexed ${data.catalogJob.productsIndexed.toLocaleString("en-US")} · Skipped ${data.catalogJob.productsSkipped.toLocaleString("en-US")} · Failed ${data.catalogJob.productsFailed.toLocaleString("en-US")}`
                    : "No catalog sync job recorded."
                }
                action={{ label: "Open settings", href: "/app/settings" }}
              />
              <ReadinessItem
                index={3}
                title="AI Search settings"
                state={searchSettingReady ? "success" : "neutral"}
                status={searchSettingReady ? "Enabled" : "Disabled"}
                detail={`Language ${data.settings.searchLanguage ?? "not configured"}${data.settings.resultLimit ? ` · ${data.settings.resultLimit} results/search` : ""}`}
                action={{ label: "Configure", href: "/app/settings" }}
              />
              <ReadinessItem
                index={4}
                title="Theme App Embed"
                state={embedReady ? "success" : "warning"}
                status={
                  data.theme.appEmbedEnabled === true
                    ? "Enabled"
                    : data.theme.appEmbedEnabled === false
                      ? "Disabled"
                      : "Unknown"
                }
                detail={
                  data.theme.appEmbedEnabled === true
                    ? `Published theme: ${data.theme.themeName ?? "unknown"} · Current app embed is active.`
                    : data.theme.appEmbedReason === "STALE_OTHER_APP_EMBED_ONLY"
                      ? `Published theme: ${data.theme.themeName ?? "unknown"} · A stale embed from another AI-Buyense app installation exists, but this app's embed is not enabled.`
                      : `Published theme: ${data.theme.themeName ?? "unknown"} · Enable this app's embed in Theme Editor.`
                }
                action={
                  data.appEmbedUrl
                    ? { label: "Open theme editor", href: data.appEmbedUrl, targetTop: true }
                    : { label: "Open settings", href: "/app/settings" }
                }
              />
              <ReadinessItem
                index={5}
                title="Theme rendering"
                state={
                  themeSyncFetcher.data?.success === false
                    ? "critical"
                    : rendererReady
                      ? "success"
                      : "warning"
                }
                status={
                  themeSyncing
                    ? "Syncing"
                    : themeSyncFetcher.data?.success === false
                      ? "Sync failed"
                      : rendererReady
                        ? "Renderer ready"
                        : "Needs check"
                }
                detail={
                  themeSyncFetcher.data?.message
                    ? themeSyncFetcher.data.message
                    : rendererReady
                      ? `Published theme renderer is available${
                          data.theme.renderStrategy ? ` · ${data.theme.renderStrategy}` : ""
                        }.`
                      : `Theme renderer unavailable · ${data.theme.integrationStatus}`
                }
                actionNode={
                  <themeSyncFetcher.Form method="post" action="/app/settings">
                    <input type="hidden" name="intent" value="sync_theme_map" />
                    <button
                      type="submit"
                      className="vip-check-button"
                      disabled={themeSyncing}
                    >
                      {themeSyncing
                        ? "Syncing theme..."
                        : rendererReady
                          ? "Resync theme"
                          : "Sync theme"}
                    </button>
                  </themeSyncFetcher.Form>
                }
              />
            </div>
          </div>

          <div className="vip-side-stack">
            <div className="vip-panel vip-health">
              <h3>System health</h3>
              <p>Live status of critical layers affecting storefront search.</p>
              <HealthRow
                label="AI Search"
                value={entitlement.searchAllowed && searchSettingReady ? "Online" : "Standby"}
                state={entitlement.searchAllowed && searchSettingReady ? "success" : "warning"}
              />
              <HealthRow
                label="Catalog"
                value={catalogReady ? "Synced" : catalogBusy ? "Syncing" : catalogStatus}
                state={catalogFailed ? "critical" : catalogReady ? "success" : "warning"}
              />
              <HealthRow
                label="Theme"
                value={rendererReady ? "Compatible" : "Check required"}
                state={rendererReady ? "success" : "warning"}
              />
              <HealthRow
                label="App Embed"
                value={embedReady ? "Enabled" : "Disabled"}
                state={embedReady ? "success" : "warning"}
              />
              <HealthRow
                label="Background queue"
                value={`${data.queue.pending} pending · ${data.queue.processing} active`}
                state={queueState}
              />
            </div>

            <div className="vip-panel vip-intel">
              <div className="vip-intel__icon">AI</div>
              <h3>Search Analytics</h3>
              <p>
                Track NO_RESULTS, LOW_SIMILARITY, and HIGH_SIMILARITY_NO_CLICK anomalies to understand what shoppers are searching for and optimize product discovery.
              </p>
              <Link to="/app/search-analytics">Open analytics →</Link>
            </div>
          </div>
        </section>

        <section className="vip-quick-grid">
          <QuickLink
            title="Catalog"
            detail="Monitor product catalog sync jobs, vector indexes, and status."
            href="/app/catalog-sync"
          />
          <QuickLink
            title="Search Analytics"
            detail="Track CTR, clicks, abnormal queries, and result quality."
            href="/app/search-analytics"
          />
          <QuickLink
            title="Usage"
            detail="Monitor search quotas, embeddings, fallbacks, and usage logs."
            href="/app/usage"
          />
          <QuickLink
            title="Plans & Billing"
            detail="Manage AI Search subscription plans and commercial quotas."
            href="/app/billing"
          />
          <QuickLink
            title="Settings"
            detail="Configure search language, result limits, AI status, and storefront options."
            href="/app/settings"
          />
          <QuickLink
            title="Theme integration"
            detail={
              data.theme.themeName
                ? `Current theme · ${data.theme.themeName}`
                : "Check App Embed and theme integration status."
            }
            href={data.appEmbedUrl ?? "/app/settings"}
            targetTop={Boolean(data.appEmbedUrl)}
          />
        </section>
      </div>
    </div>
  );
}
