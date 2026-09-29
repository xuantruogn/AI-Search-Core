# Billing Webhook / Event Matrix

## Primary subscription webhook

`APP_SUBSCRIPTIONS_UPDATE`

Use it to react to documented AppSubscription lifecycle changes.

## Handler requirements

1. Verify Shopify webhook authenticity using the app's standard webhook verification mechanism.
2. Identify the shop/store.
3. Identify the Shopify subscription.
4. Record the event or equivalent idempotency key.
5. Check whether the event has already been processed.
6. Compare incoming information with current authoritative state.
7. Update local subscription state transactionally.
8. Recalculate access.
9. Keep historical billing events.
10. Return success only after safe processing.

## Duplicate delivery

Same webhook delivered twice must produce one logical state transition.

## Out-of-order delivery

Do not assume events arrive in chronological order. The handler must prevent an older event from overwriting a newer state.

## Reconciliation

Webhooks are signals, not permission to invent state. When necessary, query Shopify and reconcile the actual subscription.

## Future/optional topics

If AI-Buyense later adds usage-based billing, also evaluate the documented billing topics for capped amounts and usage-related events.
