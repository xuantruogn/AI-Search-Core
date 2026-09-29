# Shopify State Dictionary

| Shopify state | Meaning | User-facing interpretation |
|---|---|---|
| PENDING | Subscription is awaiting merchant approval | Waiting for confirmation |
| ACTIVE | Subscription is active | Plan is active; trial/payment/cancellation context must also be checked |
| FROZEN | Subscription is frozen because of billing/payment issue | Billing problem / temporarily suspended |
| CANCELLED | Subscription has been cancelled | Subscription ended; check timing/context |
| DECLINED | Merchant declined the subscription | Subscription was not accepted |
| EXPIRED | Pending subscription expired without activation | Subscription request expired |

## Important

`ACTIVE` alone is not enough to determine the user-facing state.

For example, an ACTIVE subscription may represent:

- active trial
- paid active subscription
- active subscription scheduled not to renew

Therefore the application must combine Shopify state with relevant subscription dates, trial information, cancellation lifecycle and payment/billing information.
