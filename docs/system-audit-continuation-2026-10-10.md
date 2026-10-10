# System audit continuation — local only, 2026-10-10

## Scope and state

Continued the existing dirty worktree at HEAD `969811c4f8be943bdfb357928171c0d606535c15`. Preserved previous billing, language/index, Theme Map, search and UI changes. No reset, pull, push, merge, production access changes or deployment. The latest task attachment ends mid-sentence in A13; native fallback/quota policies were therefore preserved.

This is an implementation and regression report, **not a declaration that the entire system audit or live rollout is complete**.

## Changes in this continuation

### A04 — full-period anomalies

- Replaced the 2,000-row semantic-cluster cap and the merchant analytics 20,000-row cap with deterministic `createdAt DESC, id DESC` cursor batches of 250 over a fixed shop/time window.
- Cluster accumulators keep counters, distinct variants/products and day buckets, not every raw log or log-ID array. Raw-log memory is bounded by batch size; aggregate memory still scales with distinct query classes/products.
- Dashboard daily anomalies now derive from complete cluster day counts rather than matching sampled IDs. Removed a redundant dashboard detail query.
- Zero-result executions are abnormal independently of LLM facet availability. The >20-volume threshold applies only to low-CTR anomalies.
- Existing `(shop, createdAt)` index plus primary key supports shop/time selection and deterministic ties. No index was dropped.
- Literal query grouping on Analytics and result/fingerprint grouping for dashboard alerts remain distinct views; neither silently samples the period now.

### A06/A14 — SearchAttempt foundation and correlation

- Added `AiSearchAttempt`, with authenticated proxy purpose, query hash, started/final status, failure kind, native/cache/execution flags, result count, reservation/period/query-log IDs, duration and HTTP status.
- Request-local AsyncLocalStorage prevents concurrent shop contexts from sharing IDs. Usage metadata is attached only when the context shop matches.
- New QueryLog IDs equal their attempt IDs. Existing Click and receipt links remain compatible. Repeated analytics recording within one context reuses the existing log ID.
- Added separate Dev MTD denominators for authenticated proxy requests, search requests, pipeline executions excluding full-result cache, cache hits, native fallbacks, result-bearing searches, AI logs/clicks and incomplete attempts. Native fallback is excluded from AI CTR.
- Auth Response exceptions are preserved instead of being converted into a native fallback.
- Historical records are not backfilled or treated as missing zero-valued attempts.

**Still open:** client-supplied network retry/replay idempotency across separate HTTP requests. Each HTTP request currently receives a new server attempt ID; internal logging retries share their context. DB failures of the attempt writer are logged and incomplete/unrecorded attempts cannot be inferred from QueryLog alone. End-to-end success/cache/quota/provider/render failure scenarios need the restarted local runtime.

### A09 — durable API telemetry

- All five provider-recording call sites now await a local durable file write, not a best-effort DB insert: query Gemini, query OpenAI backup, single embedding, batch embedding and product enrichment.
- Files are atomically published after file fsync; DB writes replay in bounded batches. Request/provider/operation keys are idempotent. Missing provider IDs get an explicit local UUID; unknown historical request IDs are not reconstructed.
- Receipt tombstones survive raw-event compaction; receipt creation and event insert are transactional. Envelopes older than 180 days are not automatically counted again.
- Estimates require explicit `AI_SEARCH_MODEL_COST_RATES_JSON` entries keyed by `provider:model`, with input/cached-input/output USD-per-million rates. Removed generic fallback price estimators. Unknown rates are marked `UNKNOWN_RATE`, not asserted to cost $0.
- Daily rollup preserves unknown-rate request counts. Dev displays incomplete cost and avoids budget/margin forecasts from incomplete estimates. No provider invoice/actual cash-cost claim.

**Deployment prerequisite:** `AI_SEARCH_TELEMETRY_OUTBOX_DIR` must be persistent, access-restricted storage, not an ephemeral container filesystem. Disk failures are explicitly logged. This mechanism is not proof against every host/disk failure, nor provider-invoice reconciliation. File DB-outage replay tests use injected mock persistence, not a live DB outage.

### A18 — protected streaming export

- Reused existing Dev Search History, permission `shops.read`, security headers and shared filters.
- Added UTC inclusive date range, result-state filters, and protected CSV downloads in 250-row batches independent of UI pagination.
- Query-log CSV includes original/analyzed/expanded query, results, click count, LLM fallback, duration, cache and log/attempt IDs.
- Attempt CSV additionally includes native/error/quota states, reasons, execution/cache/native flags and reservation ID. Native rows without a QueryLog have hash-only query information and unavailable clicks. Query/LLM filters exclude rows lacking those fields; UI discloses this.
- Added formula-injection escaping, no-store, nosniff and attachment headers. No vectors, tokens, billing secrets or raw diagnostic JSON exported.
- Failed DB checks fail before a download; stream failures signal that a partial download must be discarded.

### A08/A17 — readiness

- Overall state distinguishes READY, NOT_READY and UNKNOWN; worker checks include DISABLED.
- Missing heartbeat remains UNKNOWN, expired heartbeat is DEGRADED. Process role is exposed separately; a web process can verify persisted heartbeats from separate workers.
- Added stale PROCESSING detection using product/catalog lease durations, in addition to old pending backlog counts.
- Poll leases are explicitly not job-completion proof. Old processes may need restart before new heartbeat callbacks exist.
- `/healthz` remains unchanged/lightweight; no paid AI probe added.

## Integration checks and limits

- Billing core and Dev commercial acceptance regressions pass: Basic-only trials, refund evidence/snapshots, period boundaries, Partner collector handling, uninstall HMAC/scoping. No real charge/refund, reinstall webhook replay or provider reconciliation was performed.
- Product lifecycle and data architecture tests pass. Read-only local architecture result: 1,283 profiles, average 2,639.915 bytes, maximum 16,294 bytes, 10 transport samples. Existing vector retention and deletion boundaries were not rewritten.
- Hybrid search regressions pass for identity/source ownership, complete family >500, dense/sparse fusion, absence evidence, cutoff, cache, and same-variant color/size. This is not a new live 20–50-query relevance or CTR/conversion benchmark.
- Theme V4/storefront regressions and real 12-snapshot corpus pass. Ride output assertions reject `ai_product.object_type`, verify `card-product`, product binding, ordering and native pagination. Block-family corpus PASS verifies the context transport/mount contract, not live Shopify Liquid rendering. Supply is not established by this corpus.
- Existing Dev mutations use session/MFA-derived permission and CSRF guards. New export uses the same protected Dev boundary and has no merchant write path. Whole-repository penetration testing, all-shop vector parity, mobile/desktop latency and browser CSV authorization scenarios remain unverified.

## Local migrations and files

Applied additive migrations only to `.env` datasource MySQL `ai_search` at `127.0.0.1:3306`:

- `202610100001_api_telemetry_idempotency`: event idempotency/status and daily unknown-cost count.
- `202610100002_search_attempt`: compact attempt table/indexes.
- `202610100003_telemetry_receipt`: compact dedup receipt table.

Main implementation files added:

- `app/services/search/analytics-batches.server.ts`
- `app/services/search/search-attempt-context.server.ts`
- `app/services/search/search-attempt-metrics.server.ts`
- `app/services/admin/search-history-export.ts`
- `app/routes/dev.search-history-export.ts`
- `app/services/ai/telemetry-outbox.server.ts`
- `app/services/ai/model-cost-rates.ts`
- `app/services/maintenance/readiness-policy.ts`
- `scripts/system-audit-selftest.ts`

Existing files changed for integration: merchant Search Analytics, search analytics/impact services, proxy search route, usage service, Dev history/service/dashboard, provider usage and its five call sites, API daily retention rollup, readiness service, server worker bootstrap, Prisma schema/migrations, package scripts, `.env.example`, `.gitignore`. Earlier uncommitted billing/UI changes were preserved.

## Verified evidence

- `npm run test:system-audit`: PASS, including 20,501 cursor fixture rows, date/status validation, formula escaping, readiness states, unknown model rates, filesystem replay with mock DB outage, request-context shop isolation and 403 preservation.
- Read-only live clustering vs local DB: all **1,871** logs accounted for, **572** clusters; 90-day dashboard anomaly counts **522 zero-result executions + 72 low-CTR executions**. These are different classes, not proof of actual search relevance quality.
- Read-only diagnostics: readiness **UNKNOWN**, attempt requests **0** at probe time (new runtime path had not been exercised). This is not READY or proof workers are down.
- `test:data-bound-ui`, `test:billing-core`, `test:dev-dashboard`, `test:storefront`, `test:search-hybrid`, `test:v4`, `test:product-lifecycle`, `test:data-architecture`: PASS.
- `test:v4:corpus` without arguments initially failed for missing path; rerun with `../../theme-corpus-12.json`: PASS.
- `npm run typecheck` (route typegen + tsc), local production build and `git diff --check`: PASS. Build retains existing empty-resource-chunk/dynamic-import warnings; diff has existing LF/CRLF warnings. Local `prisma migrate status` reports all 25 migrations applied, HEAD unchanged.

## Blockers / no false completion

1. `prisma generate` returns EPERM replacing the Windows query-engine DLL held by the running local process. Generated types were usable for typecheck/build, but complete generation and runtime restart are not claimed successful. Requested permission to pause/restart local dev.
2. Auto-review rejected adding SQL retention deletion for new audit tables because the task forbids data deletion. **No new database deletion was executed or added.** The safer additive receipt solution was applied without cleanup. Outbox files are acknowledged only after DB persistence; test envelopes use an isolated temporary directory. Requested explicit permission for bounded audit-table retention; until approved, long-term growth cleanup is open.
3. Persistent outbox deployment, verified per-model rates, live proxy retry/idempotency tests, physical worker progress/chaos tests and whole-system external integration checks remain prerequisites before closing the entire audit.
