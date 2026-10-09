import db from "../app/db.server";
import type { LoaderFunctionArgs } from "react-router";
if (process.env.NODE_ENV === "production") throw new Error("Local QA only");
const shop = process.env.AI_SEARCH_TEST_SHOP || "dev-app-6fvh2isn.myshopify.com";
const endpoint = process.env.AI_SEARCH_LIVE_TEST_URL;
const loader = endpoint ? null : (await import("../app/routes/dev.proxy-e2e")).loader;
try {
  const logs = await db.aiSearchQueryLog.findMany({ where: { shop }, orderBy: { createdAt: "desc" }, take: 500, select: {query: true, resultCount: true, clicks: {select:{id:true}}} });
  const queries = [...new Set([...logs.filter(l=>l.resultCount === 0).map(l=>l.query), ...logs.filter(l=>!l.clicks.length).map(l=>l.query), ...logs.map(l=>l.query)])].slice(0,20);
  const report: unknown[] = [];
  for (const query of queries) {
    const started = Date.now();
    try {
      const url = new URL(endpoint || "http://localhost:3000/dev/proxy-e2e"); url.searchParams.set("q",query);
      const response = endpoint ? await fetch(url, {signal: AbortSignal.timeout(60000)}) : await loader!({request:new Request(url),params:{},context:{}} as LoaderFunctionArgs);
      const body = await response.json();
      const receipt = body.render_receipt?.id ? await db.aiSearchResultReceipt.findUnique({where:{receiptId:body.render_receipt.id}}) : null;
      const ranked = receipt ? JSON.parse(receipt.rankedProductsJson) : [];
      const ids = ranked.slice(0,5).map((p:{productId:string})=>p.productId.startsWith("gid://")?p.productId:`gid://shopify/Product/${p.productId}`);
      const products = await db.aiSearchIndexedProduct.findMany({where:{shop,productId:{in:ids}},select:{productId:true,title:true}});
      report.push({query,status:body.status,reason:body.reason,count:ranked.length,ms:Date.now()-started,top:ids.map((id:string)=>products.find(p=>p.productId===id)?.title)});
    } catch(error) { report.push({query,error:error instanceof Error?error.message:String(error)}); }
    console.log("QA_PROGRESS",report.length,queries.length);
  }
  console.log("ANALYTICS_QA_REPORT",JSON.stringify(report));
} finally { await db.$disconnect(); }
