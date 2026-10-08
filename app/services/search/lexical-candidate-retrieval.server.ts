import { Prisma } from "@prisma/client";
import db from "../../db.server";
import { normalizeQueryText } from "./deterministic-query-parser.server";
import type { SearchResult } from "./semantic-search.server";

const STOP = new Set([
  "a","an","the","for","with","without","to","from","on","at","in","of","and","or",
  "i","me","my","want","need","find","show","something","someone","best","good",
  "most","more","less","cheap","cheapest","expensive","premium","budget",
  "toi","muon","can","tim","cho","voi","va","mot","cai","nay","do","de",
]);

function queryTokens(query: string) {
  return normalizeQueryText(query)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .filter((token) => !STOP.has(token));
}

export async function retrieveLexicalCandidates(args: {
  shop: string;
  query: string;
  limit: number;
}): Promise<SearchResult[]> {
  const tokens = [...new Set(queryTokens(args.query))];
  if (tokens.length === 0 || tokens.length > 8) return [];

  const anchor = [...tokens].sort((a, b) => b.length - a.length)[0];
  if (!anchor || anchor.length < 3) return [];
  // MySQL FULLTEXT is indexed; LIKE '%token%' forced a per-shop table
  // scan even on warm Search V11 queries, and arbitrary LIMIT 500 ordering
  // could hide an exact title. The migration installs a compound FULLTEXT
  // index on (title, handle). BM25/dense cover non-lexical recall.
  if (!/^[\p{L}\p{N}]+$/u.test(anchor)) return [];
  const booleanQuery = `${anchor}*`;
  const rows = await db.$queryRaw<
    Array<{ productId: string; handle: string; title: string }>
  >(Prisma.sql`
    SELECT \`productId\`, \`handle\`, \`title\`
    FROM \`AiSearchIndexedProduct\`
    WHERE \`shop\` = ${args.shop}
      AND \`searchable\` = true
      AND \`hasVector\` = true
      AND MATCH(\`title\`, \`handle\`) AGAINST (${booleanQuery} IN BOOLEAN MODE)
    ORDER BY MATCH(\`title\`, \`handle\`) AGAINST (${booleanQuery} IN BOOLEAN MODE) DESC,
             \`productId\` ASC
    LIMIT 500
  `);

  const normalizedQuery = normalizeQueryText(args.query);
  return rows
    .flatMap((row) => {
      const title = normalizeQueryText(row.title);
      const handle = normalizeQueryText(row.handle.replace(/-/g, " "));
      const titleHasAll = tokens.every((token) => title.split(" ").includes(token));
      const combinedHasAll = tokens.every(
        (token) =>
          title.split(" ").includes(token) || handle.split(" ").includes(token),
      );
      if (!combinedHasAll) return [];

      let lexicalScore = 0.94;
      let lexicalMatchType: SearchResult["lexicalMatchType"] = "HANDLE";
      if (title === normalizedQuery) {
        lexicalScore = 0.995;
        lexicalMatchType = "EXACT_TITLE";
      } else if (title.includes(normalizedQuery)) {
        lexicalScore = 0.985;
        lexicalMatchType = "TITLE_PHRASE";
      } else if (titleHasAll) {
        lexicalScore = 0.96;
        lexicalMatchType = "TITLE_TOKENS";
      }

      return [{
        ...row,
        score: lexicalScore,
        lexicalScore,
        lexicalMatchType,
        retrievalSources: ["LEXICAL" as const],
      }];
    })
    .sort((a, b) => (b.lexicalScore ?? 0) - (a.lexicalScore ?? 0))
    .slice(0, Math.max(1, Math.min(args.limit, 100)));
}