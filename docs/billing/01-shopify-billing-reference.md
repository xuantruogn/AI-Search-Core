# Shopify Billing Reference

## Purpose

Record the Shopify concepts that AI-Buyense relies on. Always verify against the current Shopify documentation before making implementation decisions.

## Core AppSubscription statuses

Shopify AppSubscription currently defines:

- PENDING
- ACTIVE
- FROZEN
- CANCELLED
- DECLINED
- EXPIRED

These are Shopify technical states. They are not the same thing as the user-facing status shown by AI-Buyense.

## Core subscription concepts

The implementation may need to reason about:

- subscription approval
- trial period
- current billing period
- recurring billing
- cancellation
- cancellation at period end
- immediate cancellation
- prorated credit
- frozen subscription
- subscription recovery
- subscription replacement
- upgrade/downgrade
- monthly/annual intervals
- uninstall/reinstall
- test subscriptions
- billing events
- one-time purchases
- usage-based billing

## Official documentation

- AppSubscription object:
  https://shopify.dev/docs/api/admin-graphql/latest/objects/AppSubscription
- AppSubscriptionStatus:
  https://shopify.dev/docs/api/admin-graphql/latest/enums/AppSubscriptionStatus
- Create subscription:
  https://shopify.dev/docs/api/admin-graphql/latest/mutations/appSubscriptionCreate
- Cancel subscription:
  https://shopify.dev/docs/api/admin-graphql/latest/mutations/appSubscriptionCancel
- Replacement behavior:
  https://shopify.dev/docs/api/admin-graphql/latest/enums/AppSubscriptionReplacementBehavior
- Shopify App Pricing:
  https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing
- Subscription billing:
  https://shopify.dev/docs/apps/launch/billing/manual-pricing/subscription-billing
- Billing webhooks:
  https://shopify.dev/docs/api/webhooks

## Important implementation note

Do not assume Shopify provides a literal `autoRenew` field on AppSubscription. A user-facing renewal state should be derived from the relevant Shopify subscription lifecycle/data and the application's own business state.
