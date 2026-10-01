import { createEmbeddings, getEmbeddingModel } from "../app/services/search/embeddings.server";
import { searchProductVectors } from "../app/services/search/vector-store.server";

const shop = process.env.AI_SEARCH_REGRESSION_SHOP || "dev-app-6fvh2isn.myshopify.com";
const queries = [
  "black cardigan", "charcoal cardigan", "navy cardigan",
  "red dress", "blue jacket", "leather jacket", "slim fit jeans",
  "700x35C tire", "Shimano Dura-Ace crankset",
];
const embeddingStarted = Date.now();
const vectors = await createEmbeddings(queries, { timeoutMs: 20_000, maxRetries: 0 });
const embeddingMs = Date.now() - embeddingStarted;
for (let index = 0; index < queries.length; index += 1) {
  const started = Date.now();
  const results = await searchProductVectors({ shop, vector: vectors[index], limit: 30, scoreThreshold: 0 });
  console.log(JSON.stringify({
    query: queries[index], model: getEmbeddingModel(), dimensions: vectors[index].length,
    batchedEmbeddingMs: embeddingMs, qdrantMs: Date.now() - started,
    top: results.slice(0, 10).map((item) => ({ handle: item.handle, score: Number(item.score.toFixed(4)) })),
  }));
}
