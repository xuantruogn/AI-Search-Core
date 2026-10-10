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
- The endpoint is authenticated with a bearer secret, accepts POST only, and processes at most 50 eligible subscriptions per invocation.

## Database migration

The deployment must run the normal `prisma migrate deploy` step so `nextReconciliationAt`, `reconciliationAttempt`, and `frozenFollowupUntil` exist before the endpoint is called.

Migration file: `prisma/migrations/20261010120000_billing_due_reconciliation/migration.sql`.

## Billing behavior and implementation notes

- Trial eligibility is based on durable activation history, not only the current subscription status. A shop that has previously activated a subscription must not receive a second trial after uninstall/reinstall.
- The trial is Basic-plan-only.
- Shopify's `ACTIVE` status by itself is not proof that a paid billing period exists. Trial access uses a valid trial window; post-trial paid access requires a provider-confirmed billing window. The app must not invent a new monthly period when provider dates are missing.
- The scheduled reconciliation is a fallback for missed/delayed subscription webhooks; it does not replace Shopify webhooks or the normal billing/app-entry refresh.
- Subscription updates that are already due or Frozen are scheduled for reconciliation by `app/routes/webhooks.app.subscriptions_update.tsx`.
- The reconciliation endpoint is implemented in `app/routes/internal.billing-reconcile.tsx`.
- Retry scheduling fields and their index are defined in `prisma/schema.prisma`.

## Local verification before running the development app

Run these commands from the repository root, in order:

```powershell
npm run typecheck
npm run build
npm run dev
```

Fix any typecheck/build errors before treating the change as verified. Running `npm run dev` successfully does not by itself prove that the production build is clean or that the scheduled reconciliation works.

## Deployment and smoke-test checklist

1. Confirm the intended branch and commit:
   ```powershell
   git branch --show-current
   git log -1 --oneline
   ```
2. Run `npm run typecheck` and `npm run build` locally.
3. Confirm `.env` points to the intended database and back up production data before migration if applicable.
4. Run `npm run setup` only when ready to apply the Prisma migrations to that database.
5. Deploy the app and set `BILLING_RECONCILIATION_SECRET` in its runtime environment.
6. Set the GitHub Actions secrets `BILLING_RECONCILIATION_URL` and `BILLING_RECONCILIATION_SECRET`.
7. Ensure the workflow file is on the repository's default branch; then use GitHub Actions → **Due-only Shopify Billing Reconciliation** → **Run workflow** for a manual run.
8. Verify the workflow response/logs and test expected behavior with a Shopify test shop. Do not claim the scheduler or real Shopify behavior is verified until this test passes.

## Verification status

The reconciliation implementation and this documentation are committed to the working branch, but local typecheck/build, database migration, deployed endpoint authentication, GitHub Actions execution, and real Shopify test-shop behavior must be verified in the target environment. A commit being present is not evidence that these checks passed.
