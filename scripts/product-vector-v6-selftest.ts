import assert from "node:assert/strict";
import { composeProductSemanticVectorDocumentFromTerms, composeBaseProductSemanticVectorDocument, prepareProductEmbeddingInput } from "../app/services/products/product-embedding-input.server";
import { composeContextualEmbeddingInput } from "../app/services/search/shop-context-index.server";
import { buildDirectEmbeddingPlan, buildDiscoveryEmbeddingBranches } from "../app/services/search/semantic-search.server";

const product={title:"Summer Dress",description:"A lightweight linen dress for warm weather.",productType:"dress",tags:[],vendor:"Maker"};
const terms=[
 ["CANONICAL_PRODUCT_TYPE","dress"], ["SKU","SKU-443"], ["MODEL","AB-55"],
 ["COMPATIBILITY","Device 777"], ["MEASUREMENT","12 cm"], ["ATTRIBUTE","Color=Blue"],
 ["ATTRIBUTE","100% linen"], ["ATTRIBUTE","12 cm length"], ["USE_CASE","summer wear"],
 ["SOFT_CONTEXT","warm weather"], ["INFERRED_AUDIENCE","women"],
].map(([kind,value])=>({kind,value}));
const document=composeProductSemanticVectorDocumentFromTerms({product,terms});
assert.ok(document.includes(product.description));
assert.ok(document.includes("Blue")&&document.includes("linen")&&document.includes("summer wear"));
assert.ok(!/SKU-443|AB-55|Device 777|12 cm|Color=|women/.test(document));
assert.ok(!/Canonical type:|Product type:|Attribute:|SKU:/.test(document));
assert.ok(composeBaseProductSemanticVectorDocument(product).includes(product.description));
const fallback=await prepareProductEmbeddingInput("Product: Summer Dress.\nProduct type: dress.\nDescription: A light dress.\nSKU: SKU-443.",null);
assert.ok(fallback.document.includes("A light dress"));
assert.ok(!fallback.document.includes("SKU-443"));
const query="lightweight clothing suitable for hot summer weather";
const rewrite:any={query,analysis:{intent:query,retrievalMode:"DIRECT",shopLanguageProductType:"clothing",productType:"clothing",productTypes:[],brands:[],models:[],identifiers:[],requiredAttributes:[],optionalPreferences:[],attributes:[],audience:[],compatibility:[],useCases:[],negativeTerms:[],semanticMustTerms:["summer"],semanticExpansions:["lightweight t-shirt","summer dress"]},planning:{retrievalMode:"DIRECT",semanticQuery:query,resolvedSegments:[]}};
assert.equal(composeContextualEmbeddingInput(query,rewrite,[{kind:"CATEGORY",value:"Apparel",score:50,productCount:5}]),query);
assert.equal(buildDirectEmbeddingPlan(rewrite).primary,query,"primary retains the complete need, not just identity");
rewrite.analysis.retrievalMode="DISCOVERY"; rewrite.planning.retrievalMode="DISCOVERY";
const branches=buildDiscoveryEmbeddingBranches(rewrite);
assert.ok(branches.length>0&&branches.every(v=>!v.includes(";")));
assert.equal(composeContextualEmbeddingInput(query,{...rewrite,planning:undefined},[]),query);
console.log("PASS: product/query dense text preserves natural intent and excludes serialized exact metadata");
