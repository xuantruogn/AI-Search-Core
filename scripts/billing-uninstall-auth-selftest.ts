import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {authenticateUninstallDelivery} from "../app/services/billing/uninstall-webhook-auth.server";
const secret="fixture-secret-not-a-live-credential";
const body=JSON.stringify({myshopify_domain:"uninstall-fixture.myshopify.com",id:123});
function request(raw=body,overrides:Record<string,string>={}) {
  return new Request("https://fixture.invalid/webhooks/app/uninstalled",{method:"POST",body:raw,headers:{"X-Shopify-Hmac-Sha256":createHmac("sha256",secret).update(body).digest("base64"),"X-Shopify-Shop-Domain":"uninstall-fixture.myshopify.com","X-Shopify-Webhook-Id":"fixture-delivery-1","X-Shopify-Api-Version":"2026-07","X-Shopify-Topic":"app/uninstalled",...overrides}});
}
async function main(){
  // No session/DB/Admin client exists in this test: expired/revoked credentials
  // cannot prevent an authentic uninstall from reaching the lifecycle handler.
  assert.equal((await authenticateUninstallDelivery(request(),secret)).topic,"APP_UNINSTALLED");
  const rejected=async(req:Request,status:number,key=secret)=>assert.rejects(()=>authenticateUninstallDelivery(req,key),e=>e instanceof Response && e.status===status);
  await rejected(request(body+" "),401);
  await rejected(request(body,{"X-Shopify-Hmac-Sha256":"bad"}),401);
  await rejected(request(),401,"wrong-secret");
  await rejected(request(),503,"");
  await rejected(request(body,{"X-Shopify-Topic":"products/delete"}),400);
  await rejected(request(body,{"X-Shopify-Webhook-Id":""}),400);
  await rejected(request(body,{"X-Shopify-Shop-Domain":"other.myshopify.com"}),400);
  await rejected(new Request("https://fixture.invalid/webhooks/app/uninstalled"),405);
  console.log("Session-independent uninstall HMAC, body integrity, topic, shop binding and delivery ID regression PASS");
}
void main();
