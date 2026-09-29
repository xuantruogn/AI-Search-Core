# Shopify Manual Billing State Dictionary

## AppSubscriptionStatus

Current documented values relevant to Manual Pricing:

- `PENDING`: subscription has been created but is awaiting merchant approval.
- `ACTIVE`: subscription is active.
- `FROZEN`: subscription is frozen because of billing/payment conditions.
- `CANCELLED`: subscription has been canceled.
- `DECLINED`: merchant declined the subscription.
- `EXPIRED`: subscription expired.

`ACCEPTED` is a deprecated historical value and must not be treated as a current lifecycle state.

## Related facts

Status alone is not sufficient for the complete AI-Buyense business state. Also inspect:
- subscription ID
- line items
- recurring pricing details
- interval
- price
- currency
- trial information
- current period end
- test flag
- replacement behavior used when creating a new subscription
- cancellation result/semantics
- relevant webhook/event timestamps

## State interpretation

### PENDING
Do not grant paid-plan access merely because a subscription record was created.

### ACTIVE
The subscription is active. Determine whether it is trialing and whether cancellation/non-renewal has been scheduled using the actual available Shopify data.

### FROZEN
Keep this distinct from cancellation. Access policy is an AI-Buyense business decision based on the documented billing policy; do not silently convert it to CANCELLED.

### DECLINED
Merchant did not approve the charge. The pending billing attempt should not be treated as an active paid subscription.

### CANCELLED
The subscription has been canceled. Historical access and billing period rules must be evaluated separately.

### EXPIRED
The subscription has reached its end and is no longer active.

## Source-of-truth rule

The Shopify enum is a technical state. AI-Buyense user-facing states are business states and can require multiple Shopify fields/events.
