import type { LinksFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData, useNavigation } from "react-router";

import { DevLoader } from "../components/dev-center-dashboard";
import { getDevSearchHistoryData } from "../services/admin/dev-search-history.server";
import { requireDevPermission } from "../services/dev-auth.server";
import { devSecurityHeaders } from "../services/dev-security.server";
import devCenterCss from "../styles/dev-center.css?url";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: devCenterCss },
];

export function headers() {
  return devSecurityHeaders();
}

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireDevPermission(request, "shops.read");
  const url = new URL(request.url);
  const history = await getDevSearchHistoryData(url.searchParams);

  return {
    history,
    devUser: { email: user.email, role: user.role },
    csrfToken: user.csrfToken,
  };
}

export default function DevSearchHistoryRoute() {
  const { history, devUser, csrfToken } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const { filters, pagination } = history;

  return (
    <div className="dc-shell">
      {busy ? <DevLoader label="Loading Search History..." /> : null}
      <aside className="dc-sidebar">
        <div className="dc-brand">
          <span className="dc-brand-mark">B</span>
          <span>
            <strong>AI-Buyense</strong>
            <small>Internal Dev Center</small>
          </span>
        </div>

        <nav className="dc-nav" aria-label="Dev Center navigation">
          <Link to="/dev#overview"><span>01</span>Overview</Link>
          <Link to="/dev#shops"><span>02</span>Shops</Link>
          <Link className="is-active" to="/dev/search-history"><span>03</span>Search History</Link>
          <Link to="/dev/plan-configuration"><span>04</span>Plan Configuration</Link>
          <Link to="/dev#plans"><span>05</span>Revenue</Link>
          <Link to="/dev#usage"><span>06</span>Usage & Cost</Link>
          <Link to="/dev#audit"><span>07</span>Audit</Link>
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
            <p className="dc-kicker">Search diagnostics</p>
            <h1>Search History</h1>
            <p className="dc-header-sub">
              Inspect query interpretation, LLM expansion, relevance and result health across shops.
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
              <button className="dc-button dc-button-ghost" type="submit">Sign out</button>
            </Form>
          </div>
        </header>

        <section className="dc-section">
          <div className="dc-search-history-toolbar">
            <Form method="get" className="dc-history-filters">
              <label>
                <span>Shop</span>
                <select name="shop" defaultValue={filters.shop}>
                  <option value="">All shops</option>
                  {history.shops.map((shop) => (
                    <option value={shop} key={shop}>{shop}</option>
                  ))}
                </select>
              </label>

              <label className="dc-history-query-filter">
                <span>Query</span>
                <input
                  name="query"
                  defaultValue={filters.query}
                  placeholder="Search original / analyzed / expanded query"
                />
              </label>

              <label>
                <span>LLM status</span>
                <select name="llmStatus" defaultValue={filters.llmStatus}>
                  <option value="">All statuses</option>
                  {history.llmStatuses.map((status) => (
                    <option value={status} key={status}>{status}</option>
                  ))}
                </select>
              </label>

              <label>
                <span>Rows</span>
                <select name="pageSize" defaultValue={String(filters.pageSize)}>
                  <option value="25">25</option>
                  <option value="50">50</option>
                  <option value="100">100</option>
                  <option value="250">250</option>
                </select>
              </label>

              <div className="dc-history-filter-actions">
                <button className="dc-button dc-button-primary" type="submit">Apply</button>
                <Link className="dc-button" to="/dev/search-history">Reset</Link>
              </div>
            </Form>

            <div className="dc-history-summary">
              <strong>{number(pagination.total)} searches</strong>
              <small>
                Showing {number(pagination.from)}–{number(pagination.to)}
                {filters.shop ? " · " + filters.shop : " · all shops"}
              </small>
            </div>
          </div>

          <div className="dc-table-panel">
            <div className="dc-table-scroll">
              <table className="dc-table dc-search-history-page-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Shop</th>
                    <th>Original query</th>
                    <th>LLM expansion</th>
                    <th>Embedding input</th>
                    <th>Top relevance / vector</th>
                    <th>Results</th>
                    <th>LLM</th>
                    <th>Duration</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {history.logs.map((search) => (
                    <tr key={search.id}>
                      <td className="dc-nowrap"><strong>{formatDate(search.createdAt)}</strong></td>
                      <td><strong className="dc-shop-name">{search.shop}</strong></td>
                      <td><strong className="dc-query-trace">{search.query}</strong></td>
                      <td><span className="dc-query-trace">{search.llmExpandedQuery || "—"}</span></td>
                      <td><span className="dc-query-trace">{search.analyzedQuery || search.query}</span></td>
                      <td>
                        <strong className="dc-score-value">{scoreRaw(search.topScore)}</strong>
                        <small>
                          Final {scoreRaw(search.topScore)}
                          {search.topVectorSimilarity !== null
                            ? " · vector " + scoreRaw(search.topVectorSimilarity)
                            : ""}
                          {search.topPrimaryVectorSimilarity !== null
                            ? " · primary " + scoreRaw(search.topPrimaryVectorSimilarity)
                            : ""}
                        </small>
                      </td>
                      <td>
                        <strong>{number(search.resultCount)}</strong>
                        <small>{number(search.candidateCount)} candidates</small>
                      </td>
                      <td>
                        <Status status={search.llmStatus} />
                        {search.llmFallbackReason ? <small>Fallback: {search.llmFallbackReason}</small> : null}
                      </td>
                      <td>
                        <strong>{number(search.totalDurationMs)} ms</strong>
                        <small>{search.embeddingCacheHit ? "Embedding cache hit" : "Embedding cache miss"}</small>
                      </td>
                      <td>
                        <details className="dc-json-details dc-history-details">
                          <summary>Inspect</summary>
                          <div className="dc-history-detail-grid">
                            <Detail title="LLM analysis" value={search.llmAnalysisJson} empty="No LLM analysis recorded." />
                            <Detail title="Selected context" value={search.selectedContextJson} empty="No catalog context selected." />
                            <Detail title="Ranked products" value={search.rankedProductsJson} empty="No ranked products." />
                            <div className="dc-history-diagnostic-card">
                              <strong>Diagnostics</strong>
                              <dl>
                                <dt>Top final score</dt><dd>{scoreRaw(search.topScore)}</dd>
                                <dt>Top ranked vector similarity</dt><dd>{scoreRaw(search.topVectorSimilarity)}</dd>
                                <dt>Top ranked primary-vector similarity</dt><dd>{scoreRaw(search.topPrimaryVectorSimilarity)}</dd>
                                <dt>Top retrieval candidate score</dt><dd>{scoreRaw(search.topCandidateScore)}</dd>
                                <dt>Vector threshold</dt><dd>{search.vectorThreshold.toFixed(3)}</dd>
                                <dt>Scoring</dt><dd>Final relevance combines vector similarity and reranking; it is not a probability.</dd>
                                <dt>Candidate count</dt><dd>{number(search.candidateCount)}</dd>
                                <dt>Result count</dt><dd>{number(search.resultCount)}</dd>
                                <SearchDecisionDiagnostics analysisJson={search.llmAnalysisJson} />
                              </dl>
                            </div>
                          </div>
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {history.logs.length === 0 ? (
              <div className="dc-empty">No search history matches these filters.</div>
            ) : null}

            {pagination.totalPages > 1 ? (
              <div className="dc-pagination">
                <span>Page {number(pagination.page)} of {number(pagination.totalPages)}</span>
                <div>
                  {pagination.page > 1 ? (
                    <Link className="dc-button" to={pageUrl(history.filters, pagination.page - 1)}>Previous</Link>
                  ) : (
                    <span className="dc-button is-disabled">Previous</span>
                  )}
                  {pagination.page < pagination.totalPages ? (
                    <Link className="dc-button" to={pageUrl(history.filters, pagination.page + 1)}>Next</Link>
                  ) : (
                    <span className="dc-button is-disabled">Next</span>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        </section>
      </main>
    </div>
  );
}

function Detail({ title, value, empty }: { title: string; value: string | null; empty: string }) {
  return (
    <div>
      <strong>{title}</strong>
      <pre>{prettyJson(value, empty)}</pre>
    </div>
  );
}

function Status({ status }: { status: string }) {
  const tone =
    status === "SUCCESS" || status === "CACHE_HIT" || status === "CODE_ONLY"
      ? "success"
      : status === "FALLBACK" || status === "NO_RESULT_PROOF"
        ? "warning"
        : "neutral";
  return <span className={"dc-badge is-" + tone}><i />{status}</span>;
}

function pageUrl(
  filters: {
    shop: string;
    query: string;
    llmStatus: string;
    page: number;
    pageSize: number;
  },
  page: number,
) {
  const params = new URLSearchParams();
  if (filters.shop) params.set("shop", filters.shop);
  if (filters.query) params.set("query", filters.query);
  if (filters.llmStatus) params.set("llmStatus", filters.llmStatus);
  params.set("pageSize", String(filters.pageSize));
  params.set("page", String(page));
  return "/dev/search-history?" + params.toString();
}

function prettyJson(value: string | null, empty: string) {
  if (!value) return empty;
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function SearchDecisionDiagnostics({ analysisJson }: { analysisJson: string | null }) {
  if (!analysisJson) return null;
  let analysis: Record<string, unknown>;
  try {
    analysis = JSON.parse(analysisJson) as Record<string, unknown>;
  } catch {
    return null;
  }
  const semantic = (analysis.searchDiagnostics ?? analysis.diagnostics ?? {}) as Record<string, unknown>;
  const filters = (analysis.filterDiagnostics ?? {}) as Record<string, unknown>;
  const proof = (analysis.absenceProof ?? {}) as Record<string, unknown>;
  const rows: Array<[string, unknown]> = [
    ["Retrieval mode", analysis.retrievalMode ?? semantic.retrievalMode],
    ["Route", analysis.route],
    ["Semantic resolution", analysis.semanticResolution],
    ["Strong catalog evidence", semantic.hasStrongCatalogEvidence],
    ["No-evidence guard", semantic.noEvidenceGuardTriggered],
    ["No-evidence threshold", semantic.noEvidenceThreshold],
    ["Raw top vector", semantic.topVectorScore],
    ["Absence proof", proof.status ?? semantic.finalProofStatus],
    ["Proof reason", proof.reason ?? semantic.finalProofReason],
    ["Identity filtered", filters.identityFilteredCount ?? semantic.identityFilteredCount],
    ["Color filtered", filters.colorFilteredCount ?? semantic.colorFilteredCount],
    ["Negative filtered", filters.negativeFilteredCount ?? semantic.negativeFilteredCount],
    ["Exact constraint filtered", filters.exactConstraintFilteredCount ?? semantic.exactConstraintFilteredCount],
    ["Gender filtered", filters.genderFilteredCount ?? semantic.genderFilteredCount],
  ];
  return <>{rows.filter(([, value]) => value !== undefined && value !== null).map(([label, value]) => (
    <span key={label} style={{ display: "contents" }}><dt>{label}</dt><dd>{String(value)}</dd></span>
  ))}</>;
}

function scoreRaw(value: number | null | undefined) {
  return value === null || value === undefined ? "—" : value.toFixed(3);
}

function number(value: number) {
  return value.toLocaleString();
}

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}
