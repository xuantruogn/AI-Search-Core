# Shopify → AI-Buyense State Mapping

## Principle

Do not implement a simple `shopifyStatus -> userStatus` switch. Some user states require multiple facts.

| Business state | Shopify evidence / context |
|---|---|
| U01 | No active subscription found |
| U02 | `PENDING` |
| U03 | `ACTIVE` + trial context |
| U04 | `ACTIVE` + trial context + scheduled cancellation/non-renewal |
| U05 | `ACTIVE` + paid context + no scheduled cancellation |
| U06 | `ACTIVE` + cancellation/non-renewal scheduled, current period not ended |
| U07 | Failed billing attempt / relevant payment failure information |
| U08 | `FROZEN` |
| U09 | Previously frozen/failed, now restored to active state |
| U10 | `CANCELLED` with cancellation effective |
| U11 | `EXPIRED` or current subscription period ended with no active replacement |
| U12 | `DECLINED` |
| U13 | New subscription created and awaiting approval/replacement |
| U14 | New subscription active after replacement |
| U15 | Shopify uninstall event / no longer installed |

## Cancellation rule

Cancellation must be modeled with effective timing.

A scheduled end-of-cycle cancellation is not equivalent to immediate loss of access.

## Replacement rule

For plan changes:
1. Create new subscription with the intended replacement behavior.
2. Redirect merchant to Shopify confirmation.
3. Wait for approval.
4. Reconcile Shopify state.
5. Persist the new subscription.
6. Preserve old subscription history.
7. Apply access according to the effective subscription and replacement timing.

## Proration / deferral

Shopify documents proration for plan changes and deferral in certain annual/monthly and discount scenarios. AI-Buyense must not independently invent credits that Shopify already applied.
