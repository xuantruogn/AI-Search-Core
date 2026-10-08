import assert from "node:assert/strict";
import db from "../app/db.server";
import { proveNoResult } from "../app/services/search/absence-proof.server";
import { invalidateProductSemanticProfileCache } from "../app/services/search/product-semantic-profile.server";
const count=db.aiSearchIndexedProduct.count, find=db.aiSearchProductSemanticProfile.findMany, raw=db.$queryRaw, settingsFind=db.aiSearchShopSettings.findUnique;
const plan:any={rawQuery:"size 42",normalizedQuery:"size 42",route:"CODE_SEMANTIC",retrievalMode:"DIRECT",identities:[],entities:{identifiers:[],models:[],brands:[]},attributes:[],measurements:[{value:"size 42",normalizedValue:"size 42",name:"size",mode:"MUST",confidence:1,source:"CODE"}],compatibility:[],audiences:[],contexts:[],relation:"SINGLE"};
const qdrantUrl=process.env.QDRANT_URL;delete process.env.QDRANT_URL;
// Catalog revision is accessed through its own delegate before profile lookup.
// Keep this regression fully fixture-backed: CI has no DATABASE_URL.
(db.aiSearchShopSettings as any).findUnique=async()=>null;
(db.aiSearchIndexedProduct as any).count=async()=>1;
(db as any).$queryRaw=async()=>[{productId:"fixture",shop:"absence-fixture",searchable:true,hasVector:true}];
(db.aiSearchProductSemanticProfile as any).findMany=async()=>[{id:1,productId:"fixture",updatedAt:new Date(),profile:{schemaVersion:2,values:{CANONICAL_PRODUCT_TYPE:["footwear"],ATTRIBUTE:["cotton"]}}}];
try {
 for(const phase of ["RAW","FINAL"] as const){
  invalidateProductSemanticProfileCache("absence-fixture");
  const proof=await proveNoResult({shop:"absence-fixture",plan,phase});
  assert.equal(proof.status,"UNKNOWN",`${phase}: ENRICHED does not prove source measurement coverage`);
  assert.equal(proof.coverageComplete,false);
 }
 console.log("PASS: missing closed-world source field remains UNKNOWN despite complete enrichment");
}finally{(db.aiSearchIndexedProduct as any).count=count;(db.aiSearchProductSemanticProfile as any).findMany=find;(db.aiSearchShopSettings as any).findUnique=settingsFind;(db as any).$queryRaw=raw;if(qdrantUrl)process.env.QDRANT_URL=qdrantUrl;await db.$disconnect();}
