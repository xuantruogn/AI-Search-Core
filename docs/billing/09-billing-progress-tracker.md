# Billing Progress Tracker

## Documentation baseline

- [x] Shopify Manual Pricing flow documented
- [x] AppSubscription statuses documented
- [x] Trial semantics documented
- [x] Cancellation semantics documented
- [x] Replacement/proration/deferral documented
- [x] Webhook/idempotency rules documented
- [x] User-facing U01-U15 states documented
- [x] Test matrix B01-B26 documented

## Implementation

Update these after inspecting actual AI-Buyense code:

- [ ] Shopify API version confirmed
- [ ] appSubscriptionCreate location confirmed
- [ ] appSubscriptionCancel location confirmed
- [ ] subscription query/reconciliation location confirmed
- [ ] APP_SUBSCRIPTIONS_UPDATE handler confirmed
- [ ] webhook idempotency storage confirmed
- [ ] subscription DB model mapped
- [ ] billing event DB model mapped
- [ ] access-control code mapped
- [ ] UI status mapping mapped
- [ ] monthly plan verified
- [ ] annual plan verified
- [ ] trial verified
- [ ] cancellation verified
- [ ] frozen/payment failure verified
- [ ] upgrade verified
- [ ] downgrade verified
- [ ] uninstall/reinstall verified

## Status vocabulary

Use only:
- DOCUMENTED
- IMPLEMENTED
- TESTED
- VERIFIED

Do not mark VERIFIED based only on compilation or a successful local page load.
