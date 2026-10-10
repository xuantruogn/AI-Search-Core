# Shopify App Store compliance review checklist (2026-10-10)

This checklist concerns the Buysence app configuration in
`shopify.app.ai-buyense.toml`. The private Partner Distribution URL cannot
be inspected through GitHub; a PASS in GitHub Actions is **not** proof that
the Shopify Partner review checks are passing.

## Implemented in this repository

- Mandatory compliance subscriptions: `customers/data_request`,
  `customers/redact`, and `shop/redact` have distinct route URIs in all
  three Shopify app TOMLs.
- The three HTTP actions authenticate Shopify webhooks and return `401` for
  a missing/invalid HMAC prior to processing payload or touching the DB.
- Shopify HMAC is computed over the original raw body; the original request
  remains untouched for `authenticate.webhook(request)`.
- `shop/redact` removes Qdrant vectors and tenant SQL rows, returning an
  error for retry if cleanup fails.
- CI runs `scripts/shopify-compliance-webhooks-selftest.ts`.

## Must be validated for the intended Shopify Partner app

1. Match the app's client ID in the Partner/Dev Dashboard with the
   `client_id` in `shopify.app.ai-buyense.toml` **before releasing** a
   Shopify app version. Do not deploy the default `shopify.app.toml` or
   the Trung configuration to the production app by mistake.
2. Confirm that the live `https://buysenseshopify.com` backend serves all
   three POST endpoints using the same client secret associated with that
   Shopify app. The application code must be deployed to hosting before a
   Shopify app version points to it.
3. Validate the configuration with `shopify app config validate --config ai-buyense`.
4. Create a Shopify app version without releasing it using
   `shopify app deploy --config ai-buyense --no-release`; review extension
   and config diffs, then explicitly release the verified version. Shopify
   app deploy updates Shopify configuration/extensions; it **does not**
   deploy the web server.
5. Verify bad-HMAC POST returns HTTP `401`, valid JSON webhook returns a
   `2xx` response, and `shop/redact` retry path does not silently leave
   tenant data behind.
6. Re-run the automated checks in Distribution, plus installation, OAuth,
   billing, theme app extension, HTTPS, embedded UI, pricing and listing
   tests as required by that specific Partner dashboard.

## Privacy processing limitation to resolve before review

AI-Buyense stores search terms as free text, and shoppers may type personal
information into them. These logs are not linked to Shopify customer IDs.
Therefore `customers/data_request` and `customers/redact` cannot currently
reliably locate all records associated with a particular customer; returning
a `200` acknowledgment alone is not evidence that the privacy request has
been completed. The business must establish an appropriate response,
retention and deletion policy for potentially personal user-entered queries,
and validate it with a privacy advisor if necessary.

References:
- https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
- https://shopify.dev/docs/apps/build/webhooks/verify-deliveries
- https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration
