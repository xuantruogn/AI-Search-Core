# Billing Webhook / Event Matrix

## Purpose

Track lifecycle events used by AI-Buyense.

For every event, document:

- Shopify event/topic
- payload/API object
- handler
- idempotency key
- DB changes
- access changes
- UI changes
- test case
- verification status

## Core lifecycle areas

- Subscription created
- Subscription updated
- Subscription cancellation scheduled
- Subscription cancelled
- Subscription frozen
- Subscription unfrozen
- Recurring billing success
- Recurring billing failure
- Credits/adjustments where applicable
- One-time purchase events if the product later uses them

## Idempotency requirement

Receiving the same event more than once must not create duplicate billing history, duplicate subscriptions, duplicate access grants or duplicate state transitions.
