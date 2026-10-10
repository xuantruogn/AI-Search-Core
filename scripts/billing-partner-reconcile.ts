import db from "../app/db.server";
import {partnerTransactionsConfig,reconcilePartnerTransactions} from "../app/services/billing/partner-transactions.server";
import {normalizeShopDomain} from "../app/services/billing/partner-transactions";
async function main() {
  const config = partnerTransactionsConfig();
  if (!config) {
    console.log("Partner transaction reconciliation NOT CONFIGURED. Set SHOPIFY_PARTNER_ORGANIZATION_ID, SHOPIFY_PARTNER_APP_ID, SHOPIFY_PARTNER_ACCESS_TOKEN (View financials). BILLING_TEST_MODE is not a Partner API credential.");
    process.exitCode=2;
    return;
  }
  const value = process.argv.find(arg=>arg.startsWith("--shop="))?.slice(7);
  if (!value) throw new Error("Required: --shop=example.myshopify.com (reads Shopify and imports audit evidence only)");
  const shop = normalizeShopDomain(value);
  if (!await db.aiSearchShop.findUnique({where:{shop},select:{shop:true}})) throw new Error("Unknown local shop; import refused");
  console.log(await reconcilePartnerTransactions(shop));
}
main().catch(error=>{console.error(error instanceof Error?error.message:"Partner reconciliation failed");process.exitCode=1;}).finally(()=>db.$disconnect());
