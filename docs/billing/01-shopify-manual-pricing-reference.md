# Shopify Manual Pricing / Billing API Reference

## Official source

Primary source:
Shopify Manual Pricing documentation and GraphQL Admin API billing resources.

Official references:
- About Manual Pricing
- Subscription billing with the Billing API
- Create time-based subscriptions
- Offer free trials with the Billing API
- AppSubscription object
- AppSubscriptionStatus enum
- AppSubscriptionReplacementBehavior enum
- appSubscriptionCreate
- appSubscriptionCancel
- APP_SUBSCRIPTIONS_UPDATE webhook

## Current Shopify position

Shopify currently recommends Shopify App Pricing for new public apps and supported existing apps. However, Shopify states that Manual Pricing / Billing API remains supported for existing integrations and pricing models not covered by Shopify App Pricing.

AI-Buyense intentionally uses Manual Pricing / Billing API. This document therefore follows the Manual Pricing lifecycle and must not substitute App Pricing APIs for the current implementation.

## Manual Pricing flow

1. Merchant starts an action requiring billing.
2. AI-Buyense creates the charge using the GraphQL Admin API.
3. Shopify returns a confirmation URL.
4. Merchant approves or declines on Shopify.
5. Shopify redirects to the configured return URL after approval.
6. AI-Buyense verifies the resulting subscription/charge state.
7. Subscription lifecycle changes are reconciled through Shopify state and billing webhooks.

## Time-based subscriptions

Shopify supports:
- `EVERY_30_DAYS`
- `ANNUAL`

For AI-Buyense, the plan configuration must explicitly store:
- plan identity
- billing interval
- amount
- currency
- trial duration
- Shopify subscription ID
- current period boundaries
- lifecycle state

## Subscription replacement

When a merchant changes an active plan, Shopify requires approval for the new recurring charge. The existing subscription is canceled/replaced according to the selected replacement behavior.

AI-Buyense must explicitly handle:
- upgrade
- downgrade
- same-plan re-subscription
- monthly → annual
- annual → monthly
- immediate replacement
- next-cycle replacement
- deferred billing
- proration/credits

## Uninstall

Shopify automatically cancels the app subscription when the app is uninstalled. Do not invent a special Shopify subscription status for uninstall. AI-Buyense may expose a separate business status indicating that the app was uninstalled.

## Freeze

If a store's billing account freezes, associated app subscriptions also freeze. `FROZEN` must be handled separately from cancellation.

## Trial

Free trial days delay the beginning of the paid billing cycle. Trial is contextual information, not a separate `AppSubscriptionStatus`.

## Webhook

For time-based subscriptions, Shopify documents `APP_SUBSCRIPTIONS_UPDATE` for subscription status changes. The handler must be idempotent.

## Important non-assumption

Do not model Shopify `AppSubscription` as having a literal `autoRenew` property unless the exact API version/object documentation used by the project explicitly provides such a field. User-facing renewal/cancellation state must be derived from the actual Shopify data and cancellation semantics.
