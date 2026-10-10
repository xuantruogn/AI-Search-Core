// Provider transactions are analytics evidence, not subscription entitlement
// or an invoice-period identity. Never infer a refund from a negative amount.
export const TRANSACTION_TYPES = ["AppSubscriptionSale", "AppUsageSale", "AppOneTimeSale", "AppSaleAdjustment", "AppSaleCredit"] as const;
export type PartnerMoney = { amount: string; currencyCode: string };
export type PartnerTransaction = {
  __typename: typeof TRANSACTION_TYPES[number]; id: string; createdAt: string;
  app: { id: string }; shop: { myshopifyDomain: string } | null;
  chargeId: string | null; grossAmount: PartnerMoney | null;
  netAmount: PartnerMoney; shopifyFee: PartnerMoney | null;
};
export function normalizeShopDomain(value: string) {
  const domain = value.toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain)) throw new Error("PARTNER_INVALID_SHOP");
  return domain;
}
export function validatePartnerTransaction(value: PartnerTransaction, appId: string, shop: string) {
  if (!TRANSACTION_TYPES.includes(value.__typename) || !value.id || !Number.isFinite(Date.parse(value.createdAt))) throw new Error("PARTNER_INVALID_TRANSACTION");
  if (value.app?.id !== appId || !value.shop || normalizeShopDomain(value.shop.myshopifyDomain) !== normalizeShopDomain(shop)) throw new Error("PARTNER_TRANSACTION_SCOPE_MISMATCH");
  for (const money of [value.netAmount, value.grossAmount, value.shopifyFee]) {
    if (money && (typeof money.amount !== "string" || !/^-?\d+(\.\d+)?$/.test(money.amount) || !/^[A-Z]{3}$/.test(money.currencyCode))) throw new Error("PARTNER_INVALID_MONEY");
  }
  if (!value.netAmount) throw new Error("PARTNER_INVALID_MONEY");
  return value;
}
export const PARTNER_TRANSACTIONS_QUERY = `query BillingTransactions($app: ID!, $shop: String!, $after: String, $until: DateTime!) {
  transactions(first: 50, after: $after, appId: $app, myshopifyDomain: $shop, createdAtMax: $until,
    types: [APP_SUBSCRIPTION_SALE, APP_USAGE_SALE, APP_ONE_TIME_SALE, APP_SALE_ADJUSTMENT, APP_SALE_CREDIT]) {
    edges { cursor node { __typename id createdAt
      ${TRANSACTION_TYPES.map(type => `... on ${type} { app { id } shop { myshopifyDomain } chargeId grossAmount { amount currencyCode } netAmount { amount currencyCode } shopifyFee { amount currencyCode } }`).join("\n")}
    } }
    pageInfo { hasNextPage endCursor }
  }
}`;
export async function fetchPartnerTransactionPage(config: { organizationId: string; appId: string; token: string }, shop: string, after: string | null, until: string, fetcher: typeof fetch = fetch) {
  const response = await fetcher(`https://partners.shopify.com/${config.organizationId}/api/2026-10/graphql.json`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": config.token },
    body: JSON.stringify({ query: PARTNER_TRANSACTIONS_QUERY, variables: { app: config.appId, shop: normalizeShopDomain(shop), after, until } }),
    signal: AbortSignal.timeout(15000),
  });
  // Do not log response bodies: they can contain financial data or credentials.
  if (!response.ok) throw new Error(`PARTNER_TRANSACTIONS_HTTP_${response.status}`);
  const body = await response.json() as { errors?: unknown[]; data?: { transactions?: { edges: Array<{cursor:string;node:PartnerTransaction}>; pageInfo: {hasNextPage:boolean;endCursor:string|null} } } };
  const page = body.data?.transactions;
  if (body.errors?.length || !page || !Array.isArray(page.edges) || typeof page.pageInfo?.hasNextPage !== "boolean") throw new Error("PARTNER_TRANSACTIONS_GRAPHQL_ERROR");
  if (page.pageInfo.hasNextPage && (!page.pageInfo.endCursor || page.pageInfo.endCursor === after || !page.edges.length)) throw new Error("PARTNER_TRANSACTIONS_CURSOR_STALLED");
  page.edges.forEach(edge => validatePartnerTransaction(edge.node, config.appId, shop));
  return page;
}
export async function visitPartnerTransactionPages(
  after: string | null,
  load: (cursor: string | null) => Promise<Awaited<ReturnType<typeof fetchPartnerTransactionPage>>>,
  commit: (page: Awaited<ReturnType<typeof fetchPartnerTransactionPage>>) => Promise<void>,
) {
  for (let count = 0; count < 5; count++) {
    const page = await load(after);
    // Commit must atomically persist evidence and checkpoint. Do not fetch the
    // next page until that succeeds; failures replay this page on the next run.
    await commit(page);
    if (!page.pageInfo.hasNextPage) return;
    after = page.pageInfo.endCursor;
  }
}
