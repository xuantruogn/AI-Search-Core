import { ensureProductCollection, getQdrantClient, QDRANT_COLLECTION, BM25_MODEL, BM25_OPTIONS, BM25_VECTOR_NAME, DENSE_VECTOR_NAME, VECTOR_SIZE } from "../app/services/search/qdrant.server";

await ensureProductCollection({ force: true });
const q = getQdrantClient();
const id = "00000000-0000-4000-8000-000000000999";
const dense = Array(VECTOR_SIZE).fill(0);
dense[0] = 1;
await q.upsert(QDRANT_COLLECTION, {
  wait: true,
  points: [{
    id,
    vector: {
      [DENSE_VECTOR_NAME]: dense,
      [BM25_VECTOR_NAME]: {
        text: "waterproof commuter jacket rainy weather",
        model: BM25_MODEL,
        options: BM25_OPTIONS,
      },
    },
    payload: { shop: "__smoke__", productId: "__smoke__", handle: "smoke", title: "Smoke", searchable: true },
  }],
});
const r = await q.query(QDRANT_COLLECTION, {
  query: { text: "waterproof jacket", model: BM25_MODEL, options: BM25_OPTIONS },
  using: BM25_VECTOR_NAME,
  filter: { must: [{ key: "shop", match: { value: "__smoke__" } }] },
  limit: 3,
  with_payload: true,
});
if (!r.points.length || String(r.points[0].id) !== id) throw new Error("BM25 smoke query returned no expected point");
console.log("BM25_SMOKE_PASS", { collection: QDRANT_COLLECTION, denseDimensions: VECTOR_SIZE, sparseScore: r.points[0].score });
await q.delete(QDRANT_COLLECTION, { wait: true, points: [id] });
