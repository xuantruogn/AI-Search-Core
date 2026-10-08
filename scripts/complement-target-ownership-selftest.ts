import assert from "node:assert/strict";
import db from "../app/db.server";
import {filterResultsByExplicitGender} from "../app/services/search/shop-context-index.server";
const find=db.aiSearchProductSemanticProfile.findMany;
(db.aiSearchProductSemanticProfile as any).findMany=async()=>["target","wrong-family","reference"].map(productId=>({productId,updatedAt:new Date(),profile:{schemaVersion:2,values:{CANONICAL_PRODUCT_TYPE:[productId==="target"?"shirt":productId==="reference"?"skirt":"dress"]}}}));
const rewrite:any={query:"shirt to wear with a skirt",analysis:{retrievalMode:"COMPLEMENT",productType:"shirt",productTypes:["shirt"],sourceOwnedTargetIdentities:["shirt"],shopLanguageProductType:"shirt",category:"",brands:[],models:[],identifiers:[],audience:[],requiredAttributes:[],optionalPreferences:[],attributes:[],useCases:[],compatibility:[],entities:[],shopLanguageTerms:[],englishTerms:[],negativeAttributes:[],negativeTerms:[],semanticMustTerms:[],semanticSourceMustTerms:[],semanticExpansions:[],referenceTerms:["skirt"]},planning:{retrievalMode:"COMPLEMENT",identities:[{value:"shirt",mode:"MUST",source:"DICTIONARY",confidence:1}],resolvedSegments:[],unresolvedSegments:[]},context:{}};
try {
 const results=await filterResultsByExplicitGender({shop:"complement-target-fixture",originalQuery:rewrite.query,rewrite,results:[{productId:"wrong-family",score:0.8,vectorSimilarity:0.7,primaryVectorSimilarity:0.7,retrievalSources:["SEMANTIC"]},{productId:"target",score:0.4,vectorSimilarity:0.4,primaryVectorSimilarity:0.4,retrievalSources:["SEMANTIC"]},{productId:"reference",score:0.6,vectorSimilarity:0.6,primaryVectorSimilarity:0.6,retrievalSources:["SEMANTIC"]}]});
 assert.deepEqual(results.map(r=>r.productId),["target"],"COMPLEMENT must validate named target independently of relation relevance and reference exclusion");
 console.log("PASS: named complement target owns identity; reference and other family do not become target");
}finally{(db.aiSearchProductSemanticProfile as any).findMany=find;await db.$disconnect();}

const { buildQuerySemanticProfile } = await import("../app/services/search/query-semantic-profile.server");
const sourceQuery = "shirt to wear with a black skirt";
const rawPlan:any={rawQuery:sourceQuery,normalizedQuery:sourceQuery,foldedQuery:sourceQuery,route:"FULL_LLM",retrievalMode:"COMPLEMENT",referenceTerms:["black skirt"],identities:[{value:"shirt",normalizedValue:"shirt",mode:"MUST",confidence:1,source:"DICTIONARY"}],entities:{brands:[],models:[],identifiers:[]},attributes:[],measurements:[],audiences:[],contexts:[],compatibility:[],relation:"SINGLE",marketPreference:"ANY",sort:{field:"RELEVANCE"},semanticQuery:sourceQuery,resolvedSegments:[{text:"black",start:5,end:6,canonicalValue:"black",field:"ATTRIBUTE",confidence:1,source:"DICTIONARY"}],unresolvedSegments:[],routerReason:[],versions:{dictionaryVersion:"fixture",queryParserVersion:"fixture",queryRouterVersion:"fixture"}};
const llm:any={...rewrite,query:"looking for a shirt",rewritten:true,catalogRelevant:true,analysis:{...rewrite.analysis,intent:"looking for a shirt",detectedLanguage:"en",shopLanguage:"en",confidence:1,matchedCatalogTerms:[],decisionReason:"fixture",productRelation:"SINGLE",sortIntent:"RELEVANCE",marketPreference:"ANY",semanticMandatoryConcepts:[{source:"shirt",target:"shirt"}],semanticDemand:{identity:["shirt"],desiredOutcomes:[],useCases:[],contexts:[],qualities:[],audience:[],styles:[],negativeConstraints:[],exactConstraints:[]}}};
const profile=buildQuerySemanticProfile({originalQuery:sourceQuery,rawPlan,expandedPlan:rawPlan,llm});
assert.ok(profile.embeddingInput.includes("with a black skirt"),"primary full Demand must retain source reference color with its relation");
assert.ok(!profile.finalPlan.attributes.some(a=>a.value==="black"),"reference color does not become a target constraint");
console.log("PASS: primary Demand preserves reference semantics independently of target fact filters");


