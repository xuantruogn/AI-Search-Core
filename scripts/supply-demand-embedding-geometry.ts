import { readFileSync, writeFileSync } from "node:fs";
import { createEmbeddings } from "../app/services/search/embeddings.server";

type Preview = {
  products: Array<{ handle: string; embeddingText: string }>;
  queries: Array<{ query: string; embeddingText: string }>;
};

const preview = JSON.parse(
  readFileSync(".tmp/supply-demand-preview.json", "utf8"),
) as Preview;

const texts = [
  ...preview.products.map((item) => item.embeddingText),
  ...preview.queries.map((item) => item.embeddingText),
];

const vectors = await createEmbeddings(texts, {
  usageContext: { operation: "EMBEDDING", shop: "dev-app-6fvh2isn.myshopify.com" },
});

const productVectors = vectors.slice(0, preview.products.length);
const queryVectors = vectors.slice(preview.products.length);

function cosine(a: number[], b: number[]) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

const report = preview.queries.map((query, queryIndex) => ({
  query: query.query,
  embeddingText: query.embeddingText,
  ranked: preview.products
    .map((product, productIndex) => ({
      handle: product.handle,
      score: cosine(queryVectors[queryIndex], productVectors[productIndex]),
    }))
    .sort((a, b) => b.score - a.score),
}));

writeFileSync(".tmp/supply-demand-embedding-geometry.json", JSON.stringify(report, null, 2));
for (const row of report) {
  console.log("\nQUERY", JSON.stringify(row.query));
  for (const hit of row.ranked.slice(0, 6)) {
    console.log(hit.score.toFixed(4), hit.handle);
  }
}
