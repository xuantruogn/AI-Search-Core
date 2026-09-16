import { useMemo, useState } from "react";
import type { MetaFunction } from "react-router";

import styles from "./demo.module.css";

export const meta: MetaFunction = () => [
  { title: "NOVA — AI Search Control Room" },
  {
    name: "description",
    content: "Interactive product demo for AI Search Core and LLM query rewriting.",
  },
];

type SearchResult = {
  name: string;
  meta: string;
  price: string;
  score: number;
  tag: string;
};

const demoResults: SearchResult[] = [
  {
    name: "Nimbus Run Jacket",
    meta: "Women · Running · Rain-ready",
    price: "2.490.000₫",
    score: 96,
    tag: "Best match",
  },
  {
    name: "Aero Shell Jacket",
    meta: "Unisex · Trail · Ultralight",
    price: "2.190.000₫",
    score: 91,
    tag: "High intent",
  },
  {
    name: "Drift Windbreaker",
    meta: "Women · Training · Packable",
    price: "1.690.000₫",
    score: 87,
    tag: "Good fit",
  },
];

function Icon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    overview: <><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    chart: <><path d="M4 19V5"/><path d="M4 19h16"/><path d="m7 15 4-5 4 3 5-7"/></>,
    catalog: <><path d="m4 7 8-4 8 4-8 4-8-4Z"/><path d="m4 12 8 4 8-4"/><path d="m4 17 8 4 8-4"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function Metric({ label, value, delta, tone }: { label: string; value: string; delta: string; tone: string }) {
  return (
    <article className={styles.metric}>
      <div className={styles.metricTop}><span>{label}</span><span className={styles.metricMenu}>•••</span></div>
      <strong>{value}</strong>
      <div className={styles.metricFoot}>
        <span className={styles.delta} style={{ "--tone": tone } as React.CSSProperties}>{delta}</span>
        <span>vs. 30 ngày trước</span>
      </div>
    </article>
  );
}

export default function DemoPage() {
  const [query, setQuery] = useState("áo khoác chạy bộ nữ dưới 3 triệu");
  const [submittedQuery, setSubmittedQuery] = useState(query);
  const [isRunning, setIsRunning] = useState(false);
  const [notice, setNotice] = useState("");

  const keywords = useMemo(() => {
    const normalized = submittedQuery.toLowerCase();
    if (normalized.includes("áo khoác")) return ["women jacket", "running", "weather resistant", "price < 3m"];
    return ["semantic intent", "catalog match", "price-aware"];
  }, [submittedQuery]);

  const runSearch = () => {
    if (!query.trim()) return;
    setIsRunning(true);
    setNotice("");
    window.setTimeout(() => {
      setSubmittedQuery(query.trim());
      setIsRunning(false);
    }, 650);
  };

  const toast = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 2600);
  };

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}><span className={styles.brandMark}>N</span><span>NOVA<small>AI SEARCH</small></span></div>
        <nav aria-label="Demo navigation">
          <a className={styles.activeNav} href="#overview"><Icon name="overview" />Overview</a>
          <a href="#search-lab"><Icon name="search" />Search lab</a>
          <a href="#insights"><Icon name="chart" />Insights</a>
          <a href="#catalog"><Icon name="catalog" />Catalog</a>
          <a href="#settings"><Icon name="settings" />Settings</a>
        </nav>
        <div className={styles.sidebarBottom}>
          <div className={styles.planCard}>
            <span className={styles.planEyebrow}>PRO PLAN</span>
            <strong>18.4k / 25k</strong>
            <div className={styles.progress}><i /></div>
            <small>6,600 searches còn lại</small>
          </div>
          <button className={styles.profile} onClick={() => toast("Menu tài khoản đã sẵn sàng cho bản demo.")}>
            <span className={styles.avatar}>LM</span><span><strong>Lumina Store</strong><small>Owner</small></span><b>⌄</b>
          </button>
        </div>
      </aside>

      <main className={styles.main}>
        <header className={styles.topbar}>
          <div><span className={styles.mobileLogo}>N</span><span className={styles.breadcrumb}>Workspace&nbsp; / &nbsp;<b>Overview</b></span></div>
          <div className={styles.topActions}>
            <button aria-label="Notifications" onClick={() => toast("Không có cảnh báo mới.")} className={styles.iconButton}>◌<i /></button>
            <span className={styles.status}><i /> System healthy</span>
            <button className={styles.primaryButton} onClick={() => document.querySelector("#search-lab")?.scrollIntoView({ behavior: "smooth" })}>Test a query <span>↗</span></button>
          </div>
        </header>

        <div className={styles.content}>
          <section id="overview" className={styles.intro}>
            <div>
              <span className={styles.eyebrow}>FRIDAY, 12 SEPTEMBER</span>
              <h1>Search is looking sharp.</h1>
              <p>Hệ thống hiểu đúng ý định của khách và đang chuyển đổi tốt hơn tuần trước.</p>
            </div>
            <div className={styles.timeControl}><button className={styles.selected}>30 days</button><button>90 days</button></div>
          </section>

          <section className={styles.metrics} aria-label="Performance metrics">
            <Metric label="Search sessions" value="18,429" delta="↗ 12.4%" tone="#b9ff66" />
            <Metric label="Click-through rate" value="42.8%" delta="↗ 5.7%" tone="#70e6ff" />
            <Metric label="Zero-result rate" value="3.1%" delta="↘ 2.3%" tone="#ffca6a" />
            <Metric label="Revenue influenced" value="₫284M" delta="↗ 18.9%" tone="#d4a4ff" />
          </section>

          <section className={styles.grid}>
            <article className={`${styles.panel} ${styles.performance}`}>
              <div className={styles.panelHead}>
                <div><span className={styles.eyebrow}>SEARCH PERFORMANCE</span><h2>Intent → conversion</h2></div>
                <button onClick={() => toast("Dữ liệu demo đã được làm mới.")}>Refresh ↻</button>
              </div>
              <div className={styles.chartLegend}><span><i className={styles.lime} />Searches</span><span><i className={styles.blue} />Conversions</span></div>
              <div className={styles.chart} aria-label="Search and conversion line chart">
                <div className={styles.yLabels}><span>900</span><span>600</span><span>300</span><span>0</span></div>
                <svg viewBox="0 0 760 210" preserveAspectRatio="none" role="img">
                  <defs><linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#b9ff66" stopOpacity=".25"/><stop offset="1" stopColor="#b9ff66" stopOpacity="0"/></linearGradient></defs>
                  <path className={styles.area} d="M0 190 C70 175 85 112 150 130 S245 70 315 95 S420 45 480 72 S590 25 650 55 S720 20 760 28 L760 210 L0 210Z" />
                  <path className={styles.searchLine} d="M0 190 C70 175 85 112 150 130 S245 70 315 95 S420 45 480 72 S590 25 650 55 S720 20 760 28" />
                  <path className={styles.conversionLine} d="M0 202 C90 195 125 170 180 180 S270 140 330 153 S430 112 500 132 S605 88 670 105 S730 78 760 82" />
                </svg>
                <div className={styles.xLabels}><span>15 Aug</span><span>22 Aug</span><span>29 Aug</span><span>5 Sep</span><span>12 Sep</span></div>
              </div>
            </article>

            <article className={`${styles.panel} ${styles.rewriteCard}`}>
              <div className={styles.panelHead}><div><span className={styles.eyebrow}>LLM REWRITE</span><h2>What customers meant</h2></div><span className={styles.liveBadge}>● LIVE</span></div>
              <div className={styles.queryPair}>
                <span>RAW QUERY</span><p>“ao khoac nu chay bo troi mua”</p>
                <b>↓</b>
                <span>REWRITTEN INTENT</span><p>Women&apos;s running jacket · water resistant</p>
              </div>
              <div className={styles.rewriteStats}>
                <div><span>Rewrite rate</span><strong>68%</strong></div>
                <div><span>Avg. latency</span><strong>184ms</strong></div>
              </div>
            </article>
          </section>

          <section id="search-lab" className={`${styles.panel} ${styles.lab}`}>
            <div className={styles.labHeading}>
              <div><span className={styles.eyebrow}>SEARCH LAB</span><h2>See the reasoning, not just the result.</h2></div>
              <span className={styles.environment}>DEMO ENVIRONMENT</span>
            </div>
            <div className={styles.searchBox}>
              <Icon name="search" />
              <input aria-label="Search query" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => event.key === "Enter" && runSearch()} />
              <button onClick={runSearch} disabled={isRunning}>{isRunning ? "Analyzing…" : "Analyze query"}<span>⌘↵</span></button>
            </div>
            <div className={styles.pipeline}>
              <div className={styles.intentBlock}>
                <div className={styles.blockTitle}><span>01</span><b>LLM interpretation</b><em>{isRunning ? "RUNNING" : "184 MS"}</em></div>
                <dl>
                  <div><dt>Original</dt><dd>{submittedQuery}</dd></div>
                  <div><dt>Intent</dt><dd>Women&apos;s running jacket for wet weather</dd></div>
                  <div><dt>Constraints</dt><dd><span>category: jacket</span><span>activity: running</span><span>price: &lt; 3,000,000₫</span></dd></div>
                  <div><dt>Vector query</dt><dd className={styles.keywordList}>{keywords.map((word) => <code key={word}>{word}</code>)}</dd></div>
                </dl>
              </div>
              <div className={styles.resultsBlock}>
                <div className={styles.blockTitle}><span>02</span><b>Ranked results</b><em>23 MATCHES</em></div>
                <div className={styles.resultList}>
                  {demoResults.map((result, index) => (
                    <article className={styles.result} key={result.name}>
                      <div className={styles.productShot}><span>0{index + 1}</span><small>Ảnh SP<br/>tự chụp</small></div>
                      <div className={styles.resultCopy}><span className={styles.resultTag}>{result.tag}</span><h3>{result.name}</h3><p>{result.meta}</p><strong>{result.price}</strong></div>
                      <div className={styles.score}><span>{result.score}</span><small>match</small></div>
                    </article>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section id="insights" className={styles.bottomGrid}>
            <article className={styles.panel}>
              <div className={styles.panelHead}><div><span className={styles.eyebrow}>OPPORTUNITIES</span><h2>Queries worth fixing</h2></div><button onClick={() => toast("Đã mở danh sách 27 truy vấn.")}>View all 27 →</button></div>
              <div className={styles.issueRow}><span className={styles.issueIcon}>↳</span><div><strong>“váy đi tiệc cưới biển”</strong><small>142 searches · 0 products matched</small></div><span className={styles.issueTag}>Catalog gap</span></div>
              <div className={styles.issueRow}><span className={styles.issueIcon}>↳</span><div><strong>“giày chạy ultra boost”</strong><small>96 searches · low click-through</small></div><span className={styles.issueTag}>Synonym</span></div>
              <div className={styles.issueRow}><span className={styles.issueIcon}>↳</span><div><strong>“áo polo form rộng”</strong><small>74 searches · weak ranking</small></div><span className={styles.issueTag}>Re-rank</span></div>
            </article>
            <aside className={`${styles.panel} ${styles.captureNote}`}>
              <span className={styles.eyebrow}>IMAGE NOTES</span>
              <h2>Ảnh cần tự chụp</h2>
              <ol>
                <li><b>Dashboard:</b> toàn màn hình 1440 × 1000.</li>
                <li><b>Search lab:</b> crop từ ô query đến 3 kết quả.</li>
                <li><b>Storefront:</b> chụp trang search thật sau khi bật App Embed.</li>
              </ol>
              <p>Thay các ô “Ảnh SP tự chụp” bằng ảnh sản phẩm thật trước khi quay demo chính thức.</p>
            </aside>
          </section>
        </div>
      </main>
      {notice ? <div className={styles.toast} role="status">✓ {notice}</div> : null}
    </div>
  );
}
