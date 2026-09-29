# Billing Test Matrix

## Test status

Use:

- NOT DOCUMENTED
- DOCUMENTED
- IMPLEMENTED
- TESTED
- VERIFIED
- FAILED
- BLOCKED
- OUT OF SCOPE

## Core test cases

| ID | Scenario | Expected user state | Status |
|---|---|---|---|
| B01 | No subscription | U01 | NOT TESTED |
| B02 | Create subscription, waiting approval | U02 | NOT TESTED |
| B03 | Merchant approves subscription | U03/U05 depending on trial | NOT TESTED |
| B04 | Merchant declines | U12 | NOT TESTED |
| B05 | Pending subscription expires | U11 | NOT TESTED |
| B06 | Trial active | U03 | NOT TESTED |
| B07 | Trial with renewal cancelled | U04 | NOT TESTED |
| B08 | Trial ends and billing succeeds | U05 | NOT TESTED |
| B09 | Recurring renewal succeeds | U05 | NOT TESTED |
| B10 | Cancel at period end | U06 | NOT TESTED |
| B11 | Immediate cancellation | U10 | NOT TESTED |
| B12 | Cancellation with prorated credit | U10 | NOT TESTED |
| B13 | Billing attempt fails | U07 | NOT TESTED |
| B14 | Subscription becomes frozen | U08 | NOT TESTED |
| B15 | Frozen subscription recovers | U09 | NOT TESTED |
| B16 | Upgrade immediately | U13 -> U14 | NOT TESTED |
| B17 | Upgrade at next billing cycle | U13 -> U14 | NOT TESTED |
| B18 | Downgrade immediately | U13 -> U14 | NOT TESTED |
| B19 | Downgrade at next billing cycle | U13 -> U14 | NOT TESTED |
| B20 | Monthly to annual | U13 -> U14 | NOT TESTED |
| B21 | Annual to monthly | U13 -> U14 | NOT TESTED |
| B22 | Uninstall | U15 | NOT TESTED |
| B23 | Reinstall after cancellation | U01/U02/U03/U05 depending on flow | NOT TESTED |
| B24 | Test subscription | Corresponding user state | NOT TESTED |
| B25 | Duplicate/replayed billing event | State unchanged/idempotent | NOT TESTED |
| B26 | Event arrives out of expected order | State remains consistent | NOT TESTED |

## Required verification chain

For each applicable test:

Shopify action
-> Shopify API/event
-> backend handler
-> database
-> subscription/access decision
-> UI
-> customer-facing message

A test is VERIFIED only after the complete chain is checked.
