# AI-Buyense Billing Documentation

This directory is the source of truth for Billing implementation and testing.

## Purpose

Use these documents to align:
Shopify documentation -> Shopify state/events -> business scenario -> user-facing billing status -> database -> access -> UI -> test/verification.

## Rules

1. Do not invent or rename Shopify subscription states.
2. Keep Shopify technical state separate from AI-Buyense user-facing billing status.
3. Every important billing scenario must have an implementation and test mapping.
4. Do not mark a case VERIFIED merely because code executes without an error.
5. Verification should cover Shopify/API or event -> backend -> database -> access -> UI.
6. Preserve billing history; do not delete historical subscriptions or payment records just to represent the current state.
7. For cancellation, distinguish immediate cancellation from cancellation at the end of the current period.
8. Trial, payment, renewal, cancellation, replacement, frozen, uninstall/reinstall and error cases must be considered separately.
9. When Shopify behavior is unclear, verify against current Shopify documentation before changing code.
10. Any AI/developer modifying Billing should read this directory first.

## Status lifecycle

- DOCUMENTED: Shopify behavior has been identified and referenced.
- IMPLEMENTED: application code supports the scenario.
- TESTED: the scenario has been executed.
- VERIFIED: observed behavior matches the expected Shopify, DB, access and UI behavior.

## Scope

This directory is the project-level billing specification. It should evolve with the implementation and current Shopify API behavior.
