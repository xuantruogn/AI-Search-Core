# Manual Pricing / Billing API Test Matrix

## Core cases

| ID | Scenario | Expected result |
|---|---|---|
| B01 | No subscription | U01 |
| B02 | Create recurring subscription | Shopify returns confirmation URL |
| B03 | Pending subscription | U02; no paid access before approval |
| B04 | Merchant approves | ACTIVE; correct plan/price/interval persisted |
| B05 | Merchant declines | U12; no paid access |
| B06 | Trial starts | U03; trial dates correct |
| B07 | Trial cancellation scheduled | U04; access remains until effective end |
| B08 | Paid active | U05 |
| B09 | Paid cancellation scheduled | U06; access remains through current period |
| B10 | Cancellation effective | U10/U11 according to exact Shopify state |
| B11 | Frozen subscription | U08 |
| B12 | Frozen recovery | U09 then active state |
| B13 | Payment failure | U07; correct user message and access policy |
| B14 | Upgrade | U13 → U14; verify Shopify replacement/proration |
| B15 | Downgrade | U13 → U14; verify proration/deferral |
| B16 | 30-day plan | Correct interval and period |
| B17 | Annual plan | Correct interval and period |
| B18 | Monthly → annual | Correct replacement and effective timing |
| B19 | Annual → monthly | Correct replacement/deferral |
| B20 | Uninstall | Shopify cancels subscription; local state reflects uninstall |
| B21 | Reinstall | Do not revive a canceled subscription automatically; verify actual current Shopify state |
| B22 | Test subscription | Test billing isolated from production billing assumptions |
| B23 | Duplicate webhook | No duplicate DB side effects |
| B24 | Out-of-order webhook | Older event cannot overwrite newer authoritative state |
| B25 | Wrong price/currency | Reject/flag; do not grant wrong plan |
| B26 | Return URL without reliable state | Reconcile with Shopify before granting final access |

## Additional required verification

For every passing test record:
- Shopify subscription ID
- plan ID/name
- price
- currency
- interval
- trial
- current period start/end
- Shopify status
- webhook/event ID if applicable
- local DB state
- access result
- UI result
- timestamp
- test environment
