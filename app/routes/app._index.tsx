
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
    pricingUrl: getShopifyPricingPlansUrl(session.shop),
    appEmbedUrl: getThemeAppEmbedDeepLink(session.shop),
  };
};

function formatLimit(value: number | null) {
  return value === null ? "Unlimited" : value.toLocaleString("vi-VN");
}

function formatUsage(used: number, limit: number | null) {
  return `${used.toLocaleString("vi-VN")} / ${formatLimit(limit)}`;
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
    : `${value.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%`;
}

function signedPct(value: number | null, suffix = "%") {
  if (value == null) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toLocaleString("vi-VN", {
    maximumFractionDigits: 1,
  })}${suffix}`;
}

function SearchCtrChart({
  series,
}: {
  series: Array<{ date: string; ctr: number | null; searches: number }>;
}) {
  const visible = series.slice(-30);
  const points = visible.filter((item) => item.ctr != null);

  if (points.length < 2) {
    return (
      <div className="vip-chart-empty">
        Chưa đủ dữ liệu click để vẽ xu hướng CTR.
      </div>
    );
  }

  const width = 720;
  const height = 210;
  const padX = 20;
  const padY = 18;
  const maxY = Math.max(
    10,
    Math.ceil(Math.max(...points.map((point) => point.ctr ?? 0)) / 10) * 10,
  );

  const coords = visible.map((item, index) => {
    const x =
      padX +
      (index / Math.max(1, visible.length - 1)) * (width - padX * 2);
    const value = item.ctr ?? 0;
    const y = height - padY - (value / maxY) * (height - padY * 2);
    return { ...item, x, y };
  });

  const validCoords = coords.filter((item) => item.ctr != null);
  const line = validCoords.map((item) => `${item.x},${item.y}`).join(" ");

  return (
    <div className="vip-chart-shell">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Search click-through rate over the last 30 days"
        className="vip-chart"
      >
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const y = padY + ratio * (height - padY * 2);
          const value = Math.round(maxY * (1 - ratio));
          return (
            <g key={ratio}>
              <line
                x1={padX}
                x2={width - padX}
                y1={y}
                y2={y}
                stroke="rgba(104,97,150,.12)"
                strokeWidth="1"
              />
              <text
                x={padX}
                y={Math.max(12, y - 5)}
                className="vip-chart-label"
              >
                {value}%
              </text>
            </g>
          );
        })}

        <defs>
          <linearGradient id="vipCtrFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#7764ff" stopOpacity=".26" />
            <stop offset="100%" stopColor="#7764ff" stopOpacity="0" />
          </linearGradient>
        </defs>

        {line && validCoords.length > 1 ? (
          <>
            <polygon
              points={`${line} ${validCoords[validCoords.length - 1].x},${
                height - padY
              } ${validCoords[0].x},${height - padY}`}
              fill="url(#vipCtrFill)"
            />
            <polyline
              points={line}
              fill="none"
              stroke="#6f5cf5"
              strokeWidth="3.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        ) : null}

        {validCoords.map((item, index) => (
          <circle
            key={`${item.date}-${index}`}
            cx={item.x}
            cy={item.y}
            r="3.5"
            fill="#ffffff"
            stroke="#6f5cf5"
            strokeWidth="2"
          />
        ))}
      </svg>

      <div className="vip-chart-axis">
        <span>{visible[0]?.date.slice(5).replace("-", "/")}</span>
        <span>
          {visible[Math.floor(visible.length / 2)]?.date
            .slice(5)
            .replace("-", "/")}
        </span>
        <span>
          {visible[visible.length - 1]?.date.slice(5).replace("-", "/")}
        </span>
      </div>
    </div>
  );
}

function AlertTypeLabel(type: string) {
  if (type === "NO_RESULTS") return "Không có kết quả";
  if (type === "LOW_SIMILARITY") return "Độ tương đồng thấp";
  if (type === "HIGH_SIMILARITY_NO_CLICK") return "Điểm cao nhưng không click";
  if (type === "CTR_DROP") return "CTR giảm";
  return type;
}

const dashboardCss = `
  .vip-shell {
    --vip-text: #15161a;
    --vip-muted: #666b76;
    --vip-border: #e8e8ee;
    --vip-panel: rgba(255,255,255,.92);
    --vip-shadow: 0 16px 48px rgba(30, 24, 60, .08);
    display: grid;
    gap: 20px;
    color: var(--vip-text);
    padding-bottom: 24px;
  }

  .vip-hero {
    position: relative;
    overflow: hidden;
    min-height: 240px;
    border-radius: 26px;
    padding: 30px;
    color: white;
    background:
      radial-gradient(circle at 82% 15%, rgba(117, 235, 255, .28), transparent 28%),
      radial-gradient(circle at 70% 92%, rgba(173, 121, 255, .28), transparent 36%),
      linear-gradient(135deg, #16132e 0%, #31266f 52%, #155e75 118%);
    box-shadow: 0 24px 70px rgba(47, 38, 110, .22);
  }

  .vip-hero:after {
    content: "";
    position: absolute;
    inset: 0;
    background-image: linear-gradient(rgba(255,255,255,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px);
    background-size: 34px 34px;
    mask-image: linear-gradient(to bottom left, #000, transparent 70%);
    pointer-events: none;
  }

  .vip-hero__content {
    position: relative;
    z-index: 2;
    display: grid;
    grid-template-columns: minmax(0, 1.6fr) minmax(260px, .7fr);
    gap: 30px;
    align-items: stretch;
  }

  .vip-kicker {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 18px;
    color: rgba(255,255,255,.76);
    font-size: 12px;
    font-weight: 750;
    letter-spacing: .12em;
    text-transform: uppercase;
  }

  .vip-kicker:before {
    content: "";
    width: 24px;
    height: 1px;
    background: rgba(255,255,255,.5);
  }

  .vip-hero h2 {
    margin: 0;
    max-width: 780px;
    font-size: clamp(30px, 4vw, 48px);
    line-height: 1.02;
    letter-spacing: -.04em;
  }

  .vip-hero__subtitle {
    max-width: 720px;
    margin: 15px 0 22px;
    color: rgba(255,255,255,.78);
    font-size: 15px;
    line-height: 1.65;
  }

  .vip-hero__meta {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .vip-hero__meta span {
    border: 1px solid rgba(255,255,255,.14);
    background: rgba(255,255,255,.08);
    border-radius: 999px;
    padding: 7px 10px;
    color: rgba(255,255,255,.82);
    font-size: 12px;
    backdrop-filter: blur(8px);
  }

  .vip-readiness-card {
    position: relative;
    z-index: 2;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    min-height: 178px;
    border: 1px solid rgba(255,255,255,.16);
    border-radius: 22px;
    padding: 20px;
    background: rgba(255,255,255,.09);
    backdrop-filter: blur(14px);
  }

  .vip-readiness-card__top {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    align-items: flex-start;
  }

  .vip-readiness-card__label {
    color: rgba(255,255,255,.7);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: .08em;
  }

  .vip-readiness-card__score {
    margin-top: 7px;
    font-size: 36px;
    font-weight: 800;
    letter-spacing: -.04em;
  }

  .vip-ring {
    --value: 100;
    width: 72px;
    height: 72px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: conic-gradient(#79f2c0 calc(var(--value) * 1%), rgba(255,255,255,.12) 0);
  }

  .vip-ring:after {
    content: "";
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: #282255;
    box-shadow: inset 0 0 0 1px rgba(255,255,255,.08);
  }

  .vip-readiness-card__footer {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: flex-end;
    color: rgba(255,255,255,.72);
    font-size: 12px;
  }

  .vip-readiness-card__footer strong {
    color: white;
    font-size: 13px;
  }

  .vip-pill {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    width: fit-content;
    border-radius: 999px;
    padding: 6px 9px;
    font-size: 11px;
    font-weight: 750;
    white-space: nowrap;
  }

  .vip-pill__dot { width: 7px; height: 7px; border-radius: 50%; }
  .vip-pill--success { background: #e9f8f0; color: #087443; }
  .vip-pill--success .vip-pill__dot { background: #21a366; box-shadow: 0 0 0 4px rgba(33,163,102,.12); }
  .vip-pill--warning { background: #fff6df; color: #8a5b00; }
  .vip-pill--warning .vip-pill__dot { background: #d89a17; box-shadow: 0 0 0 4px rgba(216,154,23,.12); }
  .vip-pill--critical { background: #fff0f0; color: #a32f2f; }
  .vip-pill--critical .vip-pill__dot { background: #d64b4b; box-shadow: 0 0 0 4px rgba(214,75,75,.12); }
  .vip-pill--neutral { background: #f0f1f3; color: #5f636d; }
  .vip-pill--neutral .vip-pill__dot { background: #8b909b; }

  .vip-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  .vip-action {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 38px;
    border-radius: 11px;
    padding: 0 14px;
    font-weight: 700;
    text-decoration: none;
    transition: transform .18s ease, box-shadow .18s ease, background .18s ease;
  }

  .vip-action:hover { transform: translateY(-1px); }
  .vip-action--primary { background: white; color: #27214f; box-shadow: 0 10px 24px rgba(0,0,0,.14); }
  .vip-action--ghost { border: 1px solid rgba(255,255,255,.18); color: white; background: rgba(255,255,255,.08); }

  .vip-metrics {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 14px;
  }

  .vip-metric {
    position: relative;
    overflow: hidden;
    min-height: 148px;
    border: 1px solid var(--vip-border);
    border-radius: 20px;
    padding: 18px;
    background: var(--vip-panel);
    box-shadow: 0 12px 38px rgba(30, 24, 60, .045);
  }

  .vip-metric:after {
    content: "";
    position: absolute;
    right: -34px;
    bottom: -46px;
    width: 120px;
    height: 120px;
    border-radius: 50%;
    opacity: .12;
  }

  .vip-metric--violet:after { background: #7357ff; }
  .vip-metric--cyan:after { background: #28b8d5; }
  .vip-metric--green:after { background: #30ad70; }
  .vip-metric--amber:after { background: #e6a631; }

  .vip-metric__top { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
  .vip-metric__eyebrow { color: #777b86; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
  .vip-metric__spark { width: 8px; height: 8px; border-radius: 50%; background: currentColor; opacity: .55; box-shadow: 0 0 0 5px rgba(120,110,190,.08); }
  .vip-metric__value { margin-top: 18px; font-size: 27px; font-weight: 800; letter-spacing: -.035em; }
  .vip-metric__detail { margin-top: 7px; max-width: 250px; color: #737783; font-size: 12px; line-height: 1.5; }

  .vip-progress { height: 5px; margin-top: 14px; border-radius: 999px; background: #eef0f4; overflow: hidden; }
  .vip-progress span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #6b5cff, #3bb7d0); }

  .vip-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.6fr) minmax(300px, .8fr);
    gap: 16px;
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
    padding: 20px 22px 16px;
    border-bottom: 1px solid #f0f0f4;
  }

  .vip-panel__head h3 { margin: 0; font-size: 17px; letter-spacing: -.02em; }
  .vip-panel__head p { margin: 6px 0 0; color: var(--vip-muted); font-size: 12px; line-height: 1.5; }
  .vip-panel__body { padding: 4px 22px 10px; }

  .vip-check-row {
    display: grid;
    grid-template-columns: 36px minmax(0,1fr) auto;
    gap: 14px;
    align-items: center;
    padding: 15px 0;
    border-bottom: 1px solid #f0f0f4;
  }

  .vip-check-row:last-child { border-bottom: 0; }
  .vip-check-index { width: 30px; height: 30px; border-radius: 10px; display: grid; place-items: center; font-size: 12px; font-weight: 800; }
  .vip-check-index--success { color: #087443; background: #e9f8f0; }
  .vip-check-index--warning { color: #8a5b00; background: #fff6df; }
  .vip-check-index--critical { color: #a32f2f; background: #fff0f0; }
  .vip-check-index--neutral { color: #616672; background: #f1f2f4; }
  .vip-check-title-row { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; }
  .vip-check-title-row strong { font-size: 13px; }
  .vip-check-detail { margin-top: 5px; color: var(--vip-muted); font-size: 12px; line-height: 1.45; }
  .vip-check-action { font-size: 12px; white-space: nowrap; }
  .vip-check-button {
    appearance: none;
    border: 0;
    padding: 0;
    background: transparent;
    color: #4f46c8;
    font: inherit;
    font-weight: 650;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }
  .vip-check-button:hover { color: #3328a7; }
  .vip-check-button:disabled {
    color: #9a9daa;
    cursor: wait;
    text-decoration: none;
  }

  .vip-side-stack { display: grid; gap: 16px; }
  .vip-health { padding: 20px; }
  .vip-health h3 { margin: 0 0 4px; font-size: 17px; }
  .vip-health > p { margin: 0 0 16px; color: var(--vip-muted); font-size: 12px; }
  .vip-health-row { display: flex; justify-content: space-between; gap: 16px; align-items: center; padding: 11px 0; border-bottom: 1px solid #f0f0f4; font-size: 12px; }
  .vip-health-row:last-child { border-bottom: 0; }
  .vip-health-label { display: flex; gap: 9px; align-items: center; color: #646975; }
  .vip-health-dot { width: 8px; height: 8px; border-radius: 50%; }
  .vip-health-dot--success { background: #21a366; }
  .vip-health-dot--warning { background: #d89a17; }
  .vip-health-dot--critical { background: #d64b4b; }
  .vip-health-dot--neutral { background: #9297a1; }

  .vip-intel {
    position: relative;
    overflow: hidden;
    padding: 22px;
    background: linear-gradient(145deg, #f8f7ff, #f3fbff);
  }
  .vip-intel:after { content: ""; position: absolute; width: 150px; height: 150px; border-radius: 50%; right: -48px; top: -70px; background: linear-gradient(135deg,#7c62ff,#49c2d7); opacity: .14; }
  .vip-intel__icon { width: 38px; height: 38px; border-radius: 13px; display: grid; place-items: center; background: #241d4f; color: white; font-weight: 800; box-shadow: 0 10px 24px rgba(36,29,79,.18); }
  .vip-intel h3 { margin: 16px 0 6px; font-size: 17px; }
  .vip-intel p { margin: 0 0 15px; color: var(--vip-muted); font-size: 12px; line-height: 1.55; }

  .vip-quick-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 12px; }
  .vip-quick-link { display: flex; justify-content: space-between; align-items: center; gap: 14px; border: 1px solid var(--vip-border); border-radius: 18px; padding: 16px 18px; text-decoration: none; color: inherit; background: white; transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease; }
  .vip-quick-link:hover { transform: translateY(-2px); box-shadow: 0 12px 30px rgba(38,32,72,.08); border-color: #d9d6ea; }
  .vip-quick-link strong { display: block; font-size: 13px; }
  .vip-quick-link span:not(.vip-quick-arrow) { display: block; margin-top: 5px; color: var(--vip-muted); font-size: 11px; line-height: 1.4; }
  .vip-quick-arrow { font-size: 18px; color: #6c61bb; }

  .vip-notice { display: grid; grid-template-columns: 34px 1fr; gap: 12px; align-items: start; border-radius: 16px; padding: 14px 16px; font-size: 12px; line-height: 1.5; }
  .vip-notice__icon { width: 28px; height: 28px; border-radius: 9px; display: grid; place-items: center; font-weight: 800; }
  .vip-notice strong { display: block; margin-bottom: 3px; font-size: 13px; }
  .vip-notice--critical { background: #fff2f2; color: #8b2828; border: 1px solid #f1cece; }
  .vip-notice--critical .vip-notice__icon { background: #f9dada; }
  .vip-notice--warning { background: #fff8e8; color: #815800; border: 1px solid #efdfb5; }
  .vip-notice--warning .vip-notice__icon { background: #f6e5b7; }
  .vip-notice--success { background: #edf9f2; color: #116c44; border: 1px solid #c9e8d5; }
  .vip-notice--success .vip-notice__icon { background: #d7f1e1; }
  .vip-notice--neutral { background: #f5f5f7; color: #5f636d; border: 1px solid #e4e5e8; }


  .vip-analytics-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.55fr) minmax(310px, .75fr);
    gap: 16px;
    align-items: stretch;
  }

  .vip-impact, .vip-alerts { padding: 22px; }

  .vip-impact-head {
    display: flex;
    justify-content: space-between;
    gap: 18px;
    align-items: flex-start;
    margin-bottom: 18px;
  }

  .vip-impact-head h3, .vip-alerts h3 {
    margin: 0;
    font-size: 17px;
    letter-spacing: -.02em;
  }

  .vip-impact-head p, .vip-alerts__intro {
    margin: 6px 0 0;
    color: var(--vip-muted);
    font-size: 12px;
    line-height: 1.5;
  }

  .vip-impact-kpis {
    display: grid;
    grid-template-columns: repeat(4, minmax(0,1fr));
    gap: 10px;
    margin-bottom: 16px;
  }

  .vip-impact-kpi {
    border: 1px solid #ecebf3;
    border-radius: 15px;
    padding: 13px 14px;
    background: linear-gradient(180deg,#fff,#fbfbfe);
  }

  .vip-impact-kpi span {
    display: block;
    color: #7a7e89;
    font-size: 10px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: .07em;
  }

  .vip-impact-kpi strong {
    display: block;
    margin-top: 7px;
    font-size: 21px;
    letter-spacing: -.035em;
  }

  .vip-impact-kpi small {
    display: block;
    margin-top: 4px;
    color: #9296a1;
    font-size: 10px;
    line-height: 1.4;
  }

  .vip-chart-shell {
    border: 1px solid #efedf6;
    border-radius: 18px;
    padding: 12px 10px 8px;
    background:
      radial-gradient(circle at 80% 0%, rgba(112,92,245,.08), transparent 30%),
      #fdfdff;
  }

  .vip-chart { display: block; width: 100%; height: 230px; }
  .vip-chart-label { font-size: 10px; fill: #9a9eaa; }
  .vip-chart-axis {
    display: flex;
    justify-content: space-between;
    padding: 0 9px 4px;
    color: #9a9eaa;
    font-size: 10px;
  }

  .vip-chart-empty {
    min-height: 210px;
    display: grid;
    place-items: center;
    border: 1px dashed #dcd9e8;
    border-radius: 18px;
    color: #9296a1;
    font-size: 12px;
    background: #fcfcfe;
  }

  .vip-baseline-note {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    margin-top: 12px;
    padding: 11px 12px;
    border-radius: 13px;
    border: 1px solid #e9e5d3;
    background: #fffaf0;
    color: #72591f;
    font-size: 11px;
    line-height: 1.5;
  }

  .vip-alert-list {
    display: grid;
    gap: 10px;
    margin-top: 16px;
  }

  .vip-alert {
    display: grid;
    grid-template-columns: 9px minmax(0,1fr) auto;
    gap: 10px;
    align-items: start;
    padding: 13px 0;
    border-bottom: 1px solid #f0f0f4;
  }

  .vip-alert:last-child { border-bottom: 0; }

  .vip-alert__dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-top: 5px;
  }

  .vip-alert--high .vip-alert__dot {
    background: #e14d4d;
    box-shadow: 0 0 0 5px rgba(225,77,77,.10);
  }

  .vip-alert--medium .vip-alert__dot {
    background: #dfa52c;
    box-shadow: 0 0 0 5px rgba(223,165,44,.10);
  }

  .vip-alert__title {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
    align-items: center;
    font-size: 12px;
    font-weight: 800;
  }

  .vip-alert__query {
    margin-top: 5px;
    color: #393b44;
    font-size: 12px;
    font-weight: 650;
  }

  .vip-alert__detail {
    margin-top: 4px;
    color: #858995;
    font-size: 10px;
    line-height: 1.45;
  }

  .vip-alert__count {
    min-width: 32px;
    border-radius: 999px;
    padding: 4px 7px;
    background: #f3f1fb;
    color: #6258a8;
    font-size: 10px;
    font-weight: 800;
    text-align: center;
  }

  .vip-alert-empty {
    margin-top: 16px;
    padding: 18px;
    border-radius: 16px;
    background: #f4fbf7;
    border: 1px solid #d7eee0;
    color: #327052;
    font-size: 12px;
    line-height: 1.5;
  }


  @media (max-width: 980px) {
    .vip-hero__content, .vip-grid, .vip-analytics-grid { grid-template-columns: 1fr; }
    .vip-metrics { grid-template-columns: repeat(2, minmax(0,1fr)); }
    .vip-impact-kpis { grid-template-columns: repeat(2, minmax(0,1fr)); }
    .vip-quick-grid { grid-template-columns: 1fr; }
  }

  @media (max-width: 640px) {
    .vip-hero { padding: 22px; border-radius: 20px; }
    .vip-metrics, .vip-impact-kpis { grid-template-columns: 1fr; }
    .vip-check-row { grid-template-columns: 34px minmax(0,1fr); }
    .vip-check-action { grid-column: 2; }
  }
`;

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();
  const themeSyncFetcher = useFetcher<{ success?: boolean; message?: string }>();
  const themeSyncing = themeSyncFetcher.state !== "idle";
  const { entitlement } = data;

  const catalogStatus = (data.catalogJob?.status ?? "NOT_STARTED").toUpperCase();
  const catalogReady = catalogStatus === "DONE";
  const catalogBusy = ["PENDING", "PROCESSING", "RUNNING"].includes(catalogStatus);
  const catalogFailed = catalogStatus === "FAILED" || Boolean(data.catalogJob?.lastError);
  const queueHasFailures = data.queue.failed > 0;
  const embedReady = data.theme.appEmbedEnabled === true;
  const themeReady = data.theme.integrationReady;
  const searchSettingReady = data.settings.aiSearchEnabled;

  let overall: { state: UiState; title: string; detail: string };

  if (!entitlement.active) {
    overall = {
      state: "warning",
      title: "Kích hoạt gói để bắt đầu",
      detail: "Subscription chưa active nên storefront hiện vẫn dùng Shopify Search.",
    };
  } else if (catalogFailed || queueHasFailures) {
    overall = {
      state: "critical",
      title: "Có vấn đề cần xử lý trước khi launch",
      detail: "Catalog sync hoặc product queue đang có lỗi. AI Search vẫn giữ fallback an toàn.",
    };
  } else if (!catalogReady) {
    overall = {
      state: "warning",
      title: catalogBusy ? "Đang chuẩn bị catalog" : "Catalog chưa sẵn sàng",
      detail: "Hệ thống đang chuẩn bị dữ liệu sản phẩm và vector search cho storefront.",
    };
  } else if (!searchSettingReady) {
    overall = {
      state: "neutral",
      title: "AI Search đang tạm tắt",
      detail: "Storefront đang để Shopify Search tiếp quản. Có thể bật lại bất cứ lúc nào trong Settings.",
    };
  } else if (!embedReady) {
    overall = {
      state: "warning",
      title: "Còn một bước: bật App Embed",
      detail: "Backend đã sẵn sàng. Bật App Embed trên theme hiện tại để AI Search xuất hiện ngoài storefront.",
    };
  } else if (!themeReady) {
    overall = {
      state: "warning",
      title: "Đang chờ xác nhận theme integration",
      detail: "Theme hiện tại chưa có render path được xác nhận. Shopify Search vẫn là fallback an toàn.",
    };
  } else if (!entitlement.searchAllowed) {
    overall = {
      state: "warning",
      title: "Shopify Search đang tiếp quản",
      detail: entitlement.disabledReason
        ? `AI Search tạm chưa chạy: ${entitlement.disabledReason}.`
        : "AI Search tạm chưa được phép chạy theo entitlement hiện tại.",
    };
  } else {
    overall = {
      state: "success",
      title: "AI Search đang vận hành",
      detail: "Catalog, subscription và theme integration đều đã sẵn sàng cho production traffic.",
    };
  }

  const readinessSteps = [
    entitlement.active,
    catalogReady && !catalogFailed && !queueHasFailures,
    searchSettingReady,
    embedReady,
    themeReady,
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
    entitlement.indexedProducts,
    entitlement.limits.productLimit,
  );

  const fallbackCount = entitlement.usage.fallbackCount;
  const storefrontSearches = entitlement.usage.searchCount + fallbackCount;
  const impact = data.searchImpact;
  const ctr = impact.ai.ctr;
  const current7dCtr = impact.comparison.current7dCtr;
  const previous7dCtr = impact.comparison.previous7dCtr;
  const ctrDeltaPp = impact.comparison.deltaPercentagePoints;
  const ctrDeltaRelative = impact.comparison.deltaRelativePercent;

  const aiCoverage = percent(entitlement.usage.searchCount, storefrontSearches);
  const fallbackRate = percent(fallbackCount, storefrontSearches);

  const queueState: UiState = queueHasFailures
    ? "critical"
    : data.queue.processing > 0 || data.queue.pending > 0
      ? "warning"
      : "success";

  return (
    <s-page heading="AI Search">
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
          <Notice state="critical" title="Đồng bộ cần xử lý">
            Product queue có {data.queue.failed.toLocaleString("vi-VN")} job FAILED.
            {data.catalogJob?.lastError
              ? ` Catalog error gần nhất: ${data.catalogJob.lastError}`
              : " Kiểm tra worker/log trước khi mở production traffic."}
          </Notice>
        ) : null}

        {entitlement.productLimitBlockedProducts > 0 ||
        entitlement.vectorQuotaBlockedProducts > 0 ? (
          <Notice state="warning" title="Một phần catalog chưa có vector">
            {entitlement.productLimitBlockedProducts > 0
              ? `${entitlement.productLimitBlockedProducts.toLocaleString("vi-VN")} sản phẩm đang bị chặn bởi product limit. `
              : ""}
            {entitlement.vectorQuotaBlockedProducts > 0
              ? `${entitlement.vectorQuotaBlockedProducts.toLocaleString("vi-VN")} sản phẩm đang chờ vector quota.`
              : ""}
          </Notice>
        ) : null}

        <section className="vip-metrics">
          <MetricCard
            eyebrow="Indexed products"
            value={formatUsage(entitlement.indexedProducts, entitlement.limits.productLimit)}
            detail="Sản phẩm hiện có vector và sẵn sàng tham gia AI ranking."
            progress={productProgress}
            accent="violet"
          />
          <MetricCard
            eyebrow="AI searches"
            value={formatUsage(entitlement.usage.searchCount, entitlement.limits.searchLimit)}
            detail={
              searchRemaining === null
                ? "Unlimited plan · usage vẫn được ghi nhận."
                : `Còn ${searchRemaining.toLocaleString("vi-VN")} lượt trong kỳ.`
            }
            progress={searchProgress}
            accent="cyan"
          />
          <MetricCard
            eyebrow="AI coverage"
            value={`${aiCoverage}%`}
            detail={`${entitlement.usage.searchCount.toLocaleString("vi-VN")} / ${storefrontSearches.toLocaleString("vi-VN")} storefront searches chạy qua AI.`}
            accent="green"
          />
          <MetricCard
            eyebrow="Safe fallback"
            value={`${fallbackRate}%`}
            detail={`${fallbackCount.toLocaleString("vi-VN")} lượt được Shopify Search tiếp quản an toàn.`}
            accent="amber"
          />
        </section>


        <section className="vip-analytics-grid">
          <div className="vip-panel vip-impact">
            <div className="vip-impact-head">
              <div>
                <h3>Search performance</h3>
                <p>
                  CTR = số lượt search có ít nhất một click sản phẩm / tổng lượt
                  AI search đã ghi nhận.
                </p>
              </div>
              <StatusPill state={ctr != null && ctr >= 20 ? "success" : "neutral"}>
                {`${impact.ai.searches.toLocaleString("vi-VN")} searches`}
              </StatusPill>
            </div>

            <div className="vip-impact-kpis">
              <div className="vip-impact-kpi">
                <span>AI search CTR</span>
                <strong>{fmtPct(ctr)}</strong>
                <small>
                  {impact.ai.clickedSearches.toLocaleString("vi-VN")} search có
                  click
                </small>
              </div>

              <div className="vip-impact-kpi">
                <span>7 ngày gần nhất</span>
                <strong>{fmtPct(current7dCtr)}</strong>
                <small>7 ngày trước: {fmtPct(previous7dCtr)}</small>
              </div>

              <div className="vip-impact-kpi">
                <span>CTR delta</span>
                <strong>{signedPct(ctrDeltaPp, " pp")}</strong>
                <small>{signedPct(ctrDeltaRelative)} tương đối</small>
              </div>

              <div className="vip-impact-kpi">
                <span>Avg clicked rank</span>
                <strong>
                  {impact.ai.avgClickedRank == null
                    ? "—"
                    : `#${impact.ai.avgClickedRank.toLocaleString("vi-VN", {
                        maximumFractionDigits: 1,
                      })}`}
                </strong>
                <small>
                  {impact.ai.clicks.toLocaleString("vi-VN")} product clicks
                </small>
              </div>
            </div>

            <SearchCtrChart series={impact.series} />

            {!impact.nativeBaseline.available ? (
              <div className="vip-baseline-note">
                <strong>Before AI:</strong>
                <span>
                  Chưa có dữ liệu native trước thời điểm cài app nên dashboard
                  không tạo baseline giả. Khi có native/control telemetry hợp
                  lệ, biểu đồ sẽ hiện Native vs AI tại đây.
                </span>
              </div>
            ) : null}
          </div>

          <aside className="vip-panel vip-alerts">
            <h3>Search alerts</h3>
            <div className="vip-alerts__intro">
              Chỉ nổi các bất thường lặp lại; query đơn lẻ không làm merchant bị
              spam cảnh báo.
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
                      {alert.count.toLocaleString("vi-VN")}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="vip-alert-empty">
                Chưa có cụm search bất thường đủ tần suất trong cửa sổ{" "}
                {impact.windowDays} ngày.
              </div>
            )}

            <div style={{ marginTop: 16 }}>
              <Link to="/app/search-analytics">Mở Search Analytics →</Link>
            </div>
          </aside>
        </section>

        <section className="vip-grid">
          <div className="vip-panel">
            <div className="vip-panel__head">
              <div>
                <h3>Production readiness</h3>
                <p>5 lớp cần ổn định trước khi đưa traffic thật vào AI Search.</p>
              </div>
              <StatusPill state={readinessPercent === 100 ? "success" : "warning"}>
                {readinessPercent === 100 ? "Ready to launch" : `${readinessDone}/5 complete`}
              </StatusPill>
            </div>
            <div className="vip-panel__body">
              <ReadinessItem
                index={1}
                title="Subscription"
                state={entitlement.active ? "success" : "warning"}
                status={entitlement.active ? "Active" : "Needs activation"}
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
                    ? `Processed ${data.catalogJob.productsProcessed.toLocaleString("vi-VN")} · Indexed ${data.catalogJob.productsIndexed.toLocaleString("vi-VN")} · Skipped ${data.catalogJob.productsSkipped.toLocaleString("vi-VN")} · Failed ${data.catalogJob.productsFailed.toLocaleString("vi-VN")}`
                    : "Chưa có catalog sync job."
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
                  data.theme.themeName
                    ? `Published theme: ${data.theme.themeName}`
                    : "App Embed phải được bật trên theme đang publish."
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
                    : themeReady
                      ? "success"
                      : "warning"
                }
                status={
                  themeSyncing
                    ? "Syncing"
                    : themeSyncFetcher.data?.success === false
                      ? "Sync failed"
                      : themeReady
                        ? "Ready"
                        : "Needs check"
                }
                detail={
                  themeSyncFetcher.data?.message
                    ? themeSyncFetcher.data.message
                    : `Integration: ${data.theme.integrationStatus}${
                        data.theme.renderStrategy ? ` · ${data.theme.renderStrategy}` : ""
                      }`
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
                        : themeReady
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
              <p>Live status của các lớp ảnh hưởng trực tiếp tới storefront.</p>
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
                value={themeReady ? "Compatible" : "Check required"}
                state={themeReady ? "success" : "warning"}
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
                Theo dõi NO_RESULTS, LOW_SIMILARITY và HIGH_SIMILARITY_NO_CLICK để biết khách đang tìm gì nhưng chưa nhận được kết quả đủ tốt.
              </p>
              <Link to="/app/search-analytics">Open analytics →</Link>
            </div>
          </div>
        </section>

        <section className="vip-quick-grid">
          <QuickLink
            title="Catalog"
            detail="Theo dõi đồng bộ sản phẩm, vector index và trạng thái catalog."
            href="/app/catalog-sync"
          />
          <QuickLink
            title="Search Analytics"
            detail="Xem CTR, click, truy vấn bất thường và chất lượng kết quả."
            href="/app/search-analytics"
          />
          <QuickLink
            title="Usage"
            detail="Theo dõi search quota, embeddings, fallback và mức sử dụng."
            href="/app/usage"
          />
          <QuickLink
            title="Plans & Billing"
            detail="Quản lý gói AI Search và giới hạn thương mại."
            href="/app/billing"
          />
          <QuickLink
            title="Settings"
            detail="Ngôn ngữ search, số kết quả, trạng thái AI và cấu hình storefront."
            href="/app/settings"
          />
          <QuickLink
            title="Theme integration"
            detail={
              data.theme.themeName
                ? `Current theme · ${data.theme.themeName}`
                : "Kiểm tra App Embed và theme integration."
            }
            href={data.appEmbedUrl ?? "/app/settings"}
            targetTop={Boolean(data.appEmbedUrl)}
          />
        </section>
      </div>
    </s-page>
  );
}
