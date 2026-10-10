# Shopify billing due-time reconciliation

This job does **not** poll every subscription or extend access. The GitHub Actions runner wakes every five minutes, while the application selects only rows whose trial/billing boundary has passed (or whose Shopify status is Frozen) and whose persisted `nextReconciliationAt` is due.

## Configure the scheduled trigger

Configure these GitHub Actions repository secrets:

- `BILLING_RECONCILIATION_URL`: the deployed app base URL, e.g. `https://your-real-app-host.example` (no path suffix).
- `BILLING_RECONCILIATION_SECRET`: a long random secret. Set the exact same value in the deployed app's environment.

The app endpoint is `POST /internal/billing-reconcile` and requires `Authorization: Bearer <secret>`. Do not expose the secret in the workflow file or URL.

The workflow's `schedule` event runs only after this workflow is present on the repository's default branch. Until it is merged/deployed and both secrets are configured, scheduled polling is not active. `workflow_dispatch` is available for a manual smoke test after configuration.

## Polling policy

- The first due check runs on the next scheduler tick after trial/billing expiry is persisted/eligible.
- If Shopify returns no confirmed change, retry after 5 minutes, 30 minutes, 2 hours, and 8 hours. A missing/unchanged response never adds time to the trial or billing period.
- Frozen subscriptions are checked every 8 hours for up to 7 days from the known frozen timestamp; then the automatic Frozen follow-up stops.
- A valid provider-confirmed period clears the retry schedule. Confirmed terminal statuses stop retries.
- Provider API errors are logged and retried; they are not treated as a terminal subscription state.
- Billing UI/app-entry refresh and Shopify webhooks remain in place and are independent triggers. The webhook brings a due/Frozen row forward; the scheduled job covers missing webhooks and shops that never reopen the app.

## Database migration

The deployment must run the normal `prisma migrate deploy` step so `nextReconciliationAt`, `reconciliationAttempt`, and `frozenFollowupUntil` exist before the endpoint is called.
