# Billing Access Control

## Principle

Billing state and feature access must be separate concepts.

A subscription record describes billing. An access policy determines what the merchant can use.

## Suggested access policy

| State | Paid features |
|---|---|
| U01 | No |
| U02 | No |
| U03 | Yes |
| U04 | Yes until trial end |
| U05 | Yes |
| U06 | Yes until current period end |
| U07 | Based on defined grace/payment policy |
| U08 | Based on defined frozen-account policy |
| U09 | Yes when Shopify state is active |
| U10 | No after effective cancellation |
| U11 | No |
| U12 | No |
| U13 | Existing plan access while replacement is pending, unless Shopify state says otherwise |
| U14 | Yes for new plan |
| U15 | No |

## Never do

- Grant paid access merely because a local plan row exists.
- Remove access immediately just because a user clicked Cancel if Shopify cancellation is effective at period end.
- Convert frozen into canceled.
- Trust a client-provided plan/price.
- Delete history to simplify current access logic.
