import assert from "node:assert/strict";
import { fetchPartnerTransactionPage, normalizeShopDomain, TRANSACTION_TYPES, validatePartnerTransaction, visitPartnerTransactionPages, type PartnerTransaction } from "../app/services/billing/partner-transactions";
const config = {organizationId:"123",appId:"gid://partners/App/456",token:"fixture-only"};
const shop = "fixture.myshopify.com";
const transaction = (type:PartnerTransaction["__typename"]):PartnerTransaction => ({__typename:type,id:`gid://partners/Transaction/${type}`,createdAt:"2026-10-01T00:00:00Z",app:{id:config.appId},shop:{myshopifyDomain:`https://${shop}/`},chargeId:null,grossAmount:null,netAmount:{amount:"-12.3456",currencyCode:"USD"},shopifyFee:null});
async function main() {
  assert.equal(normalizeShopDomain(`https://${shop}/`),shop);
  for (const type of TRANSACTION_TYPES) assert.equal(validatePartnerTransaction(transaction(type),config.appId,shop).__typename,type);
  assert.throws(()=>validatePartnerTransaction(transaction("AppSubscriptionSale"),"wrong",shop),/SCOPE_MISMATCH/);
  assert.throws(()=>validatePartnerTransaction(transaction("AppSubscriptionSale"),config.appId,"other.myshopify.com"),/SCOPE_MISMATCH/);
  assert.throws(()=>validatePartnerTransaction({...transaction("AppSaleCredit"),netAmount:{amount:"NaN",currencyCode:"USD"}},config.appId,shop),/INVALID_MONEY/);
  const requests:Array<Record<string,unknown>>=[];
  const mock = (async (_url,init) => {
    requests.push(JSON.parse(init!.body as string));
    return new Response(JSON.stringify({data:{transactions:{edges:[{cursor:"c1",node:transaction("AppSaleAdjustment")}],pageInfo:{hasNextPage:true,endCursor:"c1"}}}}));
  }) as typeof fetch;
  const page = await fetchPartnerTransactionPage(config,shop,null,"2026-10-10T00:00:00Z",mock);
  assert.equal(page.edges[0].node.__typename,"AppSaleAdjustment");
  assert.equal(page.edges[0].node.netAmount.amount,"-12.3456");
  assert.equal((requests[0].variables as {app:string}).app,config.appId);
  assert.ok(!(requests[0].query as string).includes("mutation"));
  await assert.rejects(()=>fetchPartnerTransactionPage(config,shop,"c1","2026-10-10T00:00:00Z",mock),/CURSOR_STALLED/);
  await assert.rejects(()=>fetchPartnerTransactionPage(config,shop,null,"2026-10-10T00:00:00Z",(async()=>new Response("",{status:403})) as typeof fetch),/HTTP_403/);
  await assert.rejects(()=>fetchPartnerTransactionPage(config,shop,null,"2026-10-10T00:00:00Z",(async()=>new Response(JSON.stringify({errors:[{message:"partial"}],data:{transactions:page}}))) as typeof fetch),/GRAPHQL_ERROR/);
  let committedCursor:string|null=null;
  let calls=0;
  const ledger=new Map<string,PartnerTransaction>();
  const load=async(cursor:string|null)=>{
    calls++;
    const index=Number(cursor??0)+1;
    return {edges:[{cursor:String(index),node:{...transaction("AppSubscriptionSale"),id:`transaction-${index}`}}],pageInfo:{endCursor:String(index),hasNextPage:index<8}};
  };
  const commit=async(value:Awaited<ReturnType<typeof fetchPartnerTransactionPage>>)=>{
    value.edges.forEach(({node})=>ledger.set(node.id,node));
    committedCursor=value.pageInfo.endCursor;
  };
  await visitPartnerTransactionPages(null,load,commit);
  assert.equal(calls,5); assert.equal(committedCursor,"5"); assert.equal(ledger.size,5);
  await assert.rejects(()=>visitPartnerTransactionPages(committedCursor,load,async()=>{throw new Error("DB_ROLLBACK");}),/DB_ROLLBACK/);
  assert.equal(committedCursor,"5"); assert.equal(ledger.size,5);
  await visitPartnerTransactionPages(committedCursor,load,commit);
  assert.equal(committedCursor,"8"); assert.equal(ledger.size,8);
  await visitPartnerTransactionPages(null,load,commit);
  assert.equal(ledger.size,8); // full-history replay does not duplicate evidence
  console.log("Partner transaction types, scoping, decimal preservation, read-only transport, partial failures and cursor safety PASS");
  console.log("Bounded page batching, commit failure, restart and replay orchestration PASS (in-memory fixture, not a DB integration test)");
}
void main();
