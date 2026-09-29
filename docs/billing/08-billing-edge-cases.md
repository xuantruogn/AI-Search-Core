# Billing Edge Cases

Track these explicitly because they commonly cause production inconsistencies.

## Cancellation

- Cancel during trial
- Cancel during paid period
- Cancel at period end
- Immediate cancellation
- Cancellation with prorated credit
- Cancellation followed by reinstall
- Cancellation while a replacement is pending

## Trial

- No trial
- Short trial
- Trial ending normally
- Trial cancellation
- Trial extension
- Trial extension followed by cancellation
- Trial ending with payment success
- Trial ending with payment failure

## Payment

- Initial approval
- Recurring success
- Recurring failure
- Frozen state
- Recovery after frozen
- Duplicate billing event
- Delayed event
- Event order mismatch

## Plan replacement

- Monthly -> monthly
- Annual -> annual
- Monthly -> annual
- Annual -> monthly
- Upgrade
- Downgrade
- Immediate replacement
- Replacement on next billing cycle
- Old subscription cancellation
- New subscription activation

## Installation

- Install
- Uninstall
- Reinstall
- Reinstall after cancelled subscription
- Reinstall after frozen subscription

## Test environment

- Test subscription
- Test payment lifecycle
- Ensure test billing cannot be mistaken for real revenue

## Future/optional billing models

If AI-Buyense introduces them later:

- One-time purchases
- Usage-based billing
- Time + usage billing
- Credits/adjustments
