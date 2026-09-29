# AI-Buyense Billing Documentation — Manual Pricing / Billing API

Version: 2.0
Scope: Shopify Manual Pricing / Billing API
Updated: 2026-09-29

## Purpose

This directory is the source of truth for AI-Buyense billing when using Shopify Manual Pricing / Billing API.

Do not mix this documentation with Shopify App Pricing / Managed Pricing. Shopify currently describes Manual Pricing as the legacy method, but it remains supported for existing integrations and pricing models not covered by Shopify App Pricing.

## Required lifecycle

For every billing case, track:

Shopify documentation → GraphQL API state/event → business scenario → AI-Buyense user status → database state → access control → UI → test → verification.

## Progress levels

- DOCUMENTED: rule is documented.
- IMPLEMENTED: code implements the rule.
- TESTED: test has been executed.
- VERIFIED: the complete chain has been checked: Shopify/API or webhook → backend → DB → access → UI.

## Current AI-Buyense scope

Primary scope:
- Recurring time-based subscriptions.
- 30-day and annual billing.
- Free trials.
- Plan changes / replacement.
- Cancellation.
- Shopify subscription lifecycle.
- APP_SUBSCRIPTIONS_UPDATE webhook.
- Payment/frozen lifecycle.
- Idempotent event processing.
- Correct price, currency, period and user-facing response.

Future/out-of-scope unless enabled:
- Usage-based billing.
- Combined recurring + usage billing.
- One-time purchases.
- Discounts/credits/refunds beyond the implementation currently used by AI-Buyense.

## Critical rules

1. Shopify is the source of truth for Shopify subscription state.
2. Do not invent Shopify enum values.
3. Do not treat trial as a separate Shopify subscription status.
4. Do not assume an `autoRenew` field exists on `AppSubscription`.
5. A cancellation scheduled for the end of the billing period must not be treated as an immediate loss of access.
6. `FROZEN` is not `CANCELLED`.
7. Preserve billing history; do not delete historical records to represent current state.
8. Webhook processing must be idempotent and tolerate duplicate delivery.
9. Do not assume event arrival order is perfect; compare timestamps/state before applying destructive transitions.
10. A redirect/return URL is not by itself the complete billing verification mechanism; reconcile with Shopify state.
11. For plan replacement, explicitly account for `AppSubscriptionReplacementBehavior` and Shopify's proration/deferral rules.
12. Annual subscriptions and 30-day subscriptions have different replacement/deferral behavior; test both.
