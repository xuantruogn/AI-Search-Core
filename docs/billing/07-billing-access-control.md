# Billing Access Control Matrix

User-facing billing state and access must be explicitly separated.

| Status | Default access expectation |
|---|---|
| U01 | No |
| U02 | No / pending |
| U03 | Yes |
| U04 | Yes until trial end |
| U05 | Yes |
| U06 | Yes until current period end |
| U07 | Follow product policy; do not assume failed payment equals cancellation |
| U08 | Usually restricted; verify intended Shopify/product behavior |
| U09 | Yes |
| U10 | No |
| U11 | No |
| U12 | No |
| U13 | Depends on replacement behavior |
| U14 | Yes |
| U15 | No |

## Rule

Never determine access from a single raw Shopify enum alone.

Access should be calculated from the complete billing state relevant to the application's policy.
