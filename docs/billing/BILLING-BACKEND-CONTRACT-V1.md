# Billing Backend Contract V1

## Purpose

AI-Buyense currently has no separate billing backend. The Billing Engine inside the app prepares the state and event data that a future backend will receive.

The runtime log entry:

`[BILLING BACKEND CONTRACT]`

is the transport-shaped representation used for verification during this phase.

## Source of truth

- Provider source of truth: Shopify Admin API subscription data.
- Notification/trigger source: CALLBACK, WEBHOOK, API, or RECONCILIATION.
- The notification transport itself is not treated as authoritative.
- Current and pending subscription pointers are stored per shop.

Shopify's current `AppSubscriptionStatus` states are:

`PENDING`, `ACTIVE`, `FROZEN`, `CANCELLED`, `DECLINED`, `EXPIRED`.

## Contract version

`BILLING_BACKEND_CONTRACT_VERSION = "1.0.0"`

## Current state payload

The contract contains:

- shop and shop lifecycle status
- current and pending subscription pointers
- current plan and plan handle
- Shopify subscription GID
- provider subscription status
- commercial status
- trial status and dates
- cancellation status
- plan-change status
- charge status
- payment status
- refund status
- access status
- reconciliation status and reason
- billing interval and period
- price and currency
- test mode
- activation, cancellation and frozen timestamps
- latest charge snapshot
- latest refund snapshot
- current event
- last five billing events

## Internal states

### Trial

`NONE`, `ACTIVE`, `ENDED`, `CANCELLED`

### Cancellation

`NONE`, `REQUESTED`, `NON_RENEWING`, `EFFECTIVE`

`REQUESTED` and `NON_RENEWING` are application business states. Shopify's subscription object exposes the provider lifecycle status; the app records these business states when a cancellation workflow explicitly sets them.

### Plan change

`NONE`, `PENDING`, `APPLIED`, `DECLINED`, `EXPIRED`, `DEFERRED`

`DEFERRED` is an internal plan-change state. The app can set it when a replacement is intended for the next billing cycle.

### Charge

`NONE`, `PENDING`, `PAID`, `FAILED`

### Payment

`NONE`, `PENDING`, `PAID`, `FAILED`, `RECOVERED`

### Refund

`NONE`, `PARTIAL`, `FULL`

The current Shopify subscription object does not contain a refund record. Refund state is therefore provider-agnostic storage at this stage and is populated by the explicit refund state service.

### Access

`NONE`, `BASIC`, `PRO`, `CUSTOM`, `SUSPENDED`

### Reconciliation

`SYNCED`, `MISMATCH`, `REPAIR_REQUIRED`

## Event history

Billing events are persisted in `billing_events` with:

- shop
- subscription GID
- event type
- source
- idempotency key
- payload
- occurredAt

This provides immutable history in addition to the current state snapshot.

## Important distinction

Provider state, business state, and event history are separate concepts.

Example:

`AppSubscription.status = ACTIVE`

does not by itself mean every payment/refund/cancellation field is independently confirmed.

The backend contract therefore sends both:

1. current state
2. current event context

and retains immutable billing events for reconstruction/audit.

## Current implementation boundary

The following are implemented now:

- Shopify subscription lifecycle state capture
- current/pending entitlement pointers
- trial derivation
- cancellation state setter
- deferred plan-change state setter
- charge/payment derived state
- refund state persistence service
- reconciliation mismatch handling
- idempotent billing events
- backend-shaped log contract

What is not claimed as provider-observed yet:

- refund status directly read from the Shopify AppSubscription object
- cancellation REQUESTED/NON_RENEWING directly read from Shopify AppSubscription.status
- every matrix state being runtime-tested against a real Shopify scenario

Those states are represented in the contract so the eventual backend does not need a schema redesign.

## Runtime verification

After a billing action or reconciliation, search logs for:

`[BILLING BACKEND CONTRACT]`

The JSON object immediately following that marker is the data contract to inspect during this development phase.
