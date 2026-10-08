import assert from "node:assert/strict";
import { applyFinalRelevanceCutoff } from "../app/services/search/final-relevance-cutoff.server";
const candidate = (id: string, primary: number | undefined, sources: Array<"SEMANTIC"|"SPARSE"|"LEXICAL"|"STRUCTURED">) => ({ productId:id, score:0.9, vectorSimilarity:0.61, primaryVectorSimilarity:primary, retrievalSources:sources });
for (const mode of ["DIRECT", "DISCOVERY", "COMPLEMENT"] as const) {
 const results = applyFinalRelevanceCutoff({retrievalMode:mode, semanticThreshold:0.35, results:[
  candidate("full-demand",0.42,["SEMANTIC","SPARSE"]),
  candidate("weak-primary",0.21,["SEMANTIC","SPARSE"]),
  candidate("branch-only",undefined,["SEMANTIC"]),
  candidate("lexical-corroborated",undefined,["LEXICAL","SPARSE"]),
 ]});
 assert.deepEqual(results.map(r=>r.productId),["full-demand"],`${mode}: branch/keyword agreement must not replace primary Demand relevance`);
}
for (const mode of ["DISCOVERY", "COMPLEMENT"] as const) {
 const results = applyFinalRelevanceCutoff({retrievalMode:mode,semanticThreshold:0.35,results:[
  {...candidate("partial-fact",undefined,["STRUCTURED"]),structuredAnchorKinds:["MEASUREMENT"]},
  {...candidate("exact-reference",undefined,["LEXICAL"]),lexicalMatchType:"EXACT_TITLE" as const},
 ]});
 assert.equal(results.length,0,`${mode}: exact component/reference fact cannot prove open-world whole Demand`);
}
assert.equal(applyFinalRelevanceCutoff({retrievalMode:"DIRECT",semanticThreshold:0.35,results:[{...candidate("identifier",undefined,["STRUCTURED"]),structuredAnchorKinds:["IDENTIFIER"]}]}).length,1,"source-validated DIRECT identifier lookup keeps exact authority");
console.log("PASS: full Demand evidence owns final relevance across modes; exact reference/partial facts do not rescue open-world requests");
