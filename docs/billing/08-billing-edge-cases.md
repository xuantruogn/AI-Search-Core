# Billing Edge Cases

## 1. Cancel at end of period

User cancels renewal while current subscription remains active.

Expected:
- preserve current subscription
- keep access until effective end
- clearly show that it will not continue into the next period
- after effective end, transition to inactive/expired/canceled business state

## 2. Immediate cancellation

If the implemented Shopify cancellation operation makes cancellation effective immediately, access must follow the resulting Shopify state and effective timing.

## 3. Trial cancellation

Trial cancellation is not a separate Shopify status. Store enough data to determine that the subscription is active trial + cancellation scheduled.

## 4. Frozen

Frozen is a billing/payment suspension. Do not equate it with cancellation.

## 5. Upgrade

Shopify may prorate the new charge. Do not duplicate credits or calculations already handled by Shopify.

## 6. Downgrade

Shopify may issue a prorated credit or defer a new plan depending on billing intervals and replacement rules. Verify actual Shopify result.

## 7. Annual → 30-day

Shopify documents cases where the new plan is deferred until the current annual billing cycle completes.

## 8. Uninstall

Shopify automatically cancels the subscription on uninstall. Preserve historical billing information.

## 9. Reinstall

Do not assume the previous subscription becomes active again. Reconcile the current Shopify state.

## 10. Return URL manipulation

Never grant a paid plan based solely on a manipulated return URL or client parameters. Verify server-side with Shopify.

## 11. Duplicate webhook

Must be idempotent.

## 12. Webhook arrives before redirect

The webhook may update local state before the merchant reaches the return URL. The return route must be able to handle already-updated state.

## 13. Redirect arrives before webhook

The return route should reconcile Shopify state; later webhook processing must be idempotent.

## 14. Shopify/API version changes

Pin and document the GraphQL Admin API version used by the app. Review this document whenever the API version is upgraded.
