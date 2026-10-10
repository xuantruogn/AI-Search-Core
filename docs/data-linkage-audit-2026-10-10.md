# Local data linkage audit — 2026-10-10

Continuation: see `system-audit-continuation-2026-10-10.md` for new SearchAttempt, whole-period batching, telemetry/outbox, CSV and readiness work. The sections below record the previous pass and must not be interpreted as the latest completion status.

Input audit was based on Main `b7c6a829754732207679ca406136f310722b10d1`. Current local HEAD is `969811c4f8be943bdfb357928171c0d606535c15`, plus uncommitted billing and audit changes. No reset, pull, production mutation or deployment was performed. Production SHA/migrations have not been verified.

## Addressed in this local pass

- A01: auth happens outside analytics fallback handling; thrown Response is preserved. Backend failure returns HTTP 503 with UNAVAILABLE/trace ID and retry UI, not rendered zero KPIs. Successful empty reads use EMPTY separately. Trace output omits queries/secrets/error text.
- A02: removed static green verification ticks. Unmeasured quality checks explicitly say UNKNOWN. Recorded clicks alone do not prove tracking health.
- A03: full retained-log totals, clicked-search counts, click counts/rank averages and daily search/CTR chart use SQL aggregation. Details remain bounded and partial anomaly statistics are disclosed. Dashboard comparison now queries the preceding 7 days even when displaying a 7-day window.
- A04: mitigation, not a full closure. Clustering still caps at 2,000 recent logs; dashboard declares sampling and cannot state the full period is anomaly-free. Cluster and dashboard time boundaries now match. Full-window cluster aggregation remains open.
- A05: landing uses fresh DB public/active Manual Billing plans, filters private/custom assignments, shares money formatting with Billing and removes false Pro free-trial claims. No-store prevents a stale pricing cache. Provider-managed App Pricing remains configured in Shopify, not modified by this reader.
- A07/A15: every job status/error field uses liveJob, including authoritative live null. Pagination validates whole safe integers and clamps against total pages before calculating Prisma skip.
- A08/A17: added `/readyz`, cached Qdrant V9 collection/schema check, DB check, persisted product/catalog poll heartbeat using reserved system lease records, and old pending-job warning. Results appear in existing Dev diagnostics. `/healthz` remains lightweight. Worker polling is not proof of completed jobs; Shopify and AI provider checks remain UNKNOWN, with no paid probe on each request. No full deployment/queue chaos test performed.
- A09: UI cost is clearly Estimated API cost, configured token rates and potentially incomplete telemetry. Durable outbox/reconciliation remains open; no invoice-level claim.
- A10: retained existing subscription run-rate disclosure. Existing Partner collector records evidence, not automatic cash/refund allocation.
- A11: uncapped global shop/active-shop/product totals, latest-period usage sums and provider totals replace capped-table reductions. Shop table still caps at 500; AI-operational count is explicitly table-scoped. Full shop-table pagination remains open.
- A12/A14: Usage events filter current periodId; combined execution/fallback count is no longer called all storefront requests. AI query logs remain a different denominator from proxy attempts.
- A16: zero quota has finite presentation, blocked/no-capacity label, never NaN percent.

## Still open / not claimed complete

- A06/A14: immutable correlated SearchAttempt across success, cache, zero result, native fallback, blocked and pipeline errors. Current fallback UsageEvent exists but is not QueryLog; do not mix fallback rows into AI CTR/relevance metrics.
- A09: durable provider telemetry outbox and request-ID reconciliation; missed inserts cannot be reconstructed merely from current counters. Model-specific rate verification also remains open.
- A13: kept current native fallback on exhausted AI quota. Backup AI is not silently granted as free overuse. Changing this requires an explicit product policy.
- A18: protected, bounded/streaming CSV export remains open.
- Production SHA/migrations, all-shop Shopify/MySQL/Qdrant parity, theme render/pagination, real webhook replay, >20k DB seed, 501-shop seed and dependency chaos tests are not performed by this pass. Existing billing policy/auth improvements were preserved.

## Verification scope

- `test:data-bound-ui`: pagination, zero quotas, >20k aggregate fixture, shared currency formatting and actual source wiring assertions. These are not browser-level DB-failure/chaos tests.
- Read-only local SQL vs Prisma comparison for dev shop: 1,871 query logs and 13 clicked searches matched at test time. No synthetic logs/shops were inserted into merchant DB.
- Local readiness probe: database PASS, Qdrant V9 schema PASS, pending queue-age PASS; product/catalog worker UNKNOWN (no new heartbeat evidence), Shopify/AI providers UNKNOWN. This is NOT_READY, not proof that workers are down. A running pre-patch process may need a restart to load new poll callbacks.
- Typecheck, billing core, Dev Dashboard, storefront and production build are run separately; consult the final execution results rather than interpreting this document as proof of production readiness.
