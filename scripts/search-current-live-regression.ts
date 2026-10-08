import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import db from "../app/db.server";
import { loadProductSemanticRows } from "../app/services/search/product-semantic-profile.server";

// Development-only regression for the 7 Oct 2026 failures.
// This exercises the existing signed /dev/proxy-e2e wrapper and validates the
// actual ranked receipt, not just HTTP success.
if (process.env.NODE_ENV === "production") {
  throw new Error("Development test only");
}

const sourceFile = process.env.AI_SEARCH_CATALOG_SOURCE_FILE;
const sourceSnapshot = sourceFile ? JSON.parse(readFileSync(sourceFile, "utf8")) : null;
if (sourceSnapshot && (sourceSnapshot.status !== "SOURCE_READ_SUCCESS" ||
    sourceSnapshot.shop !== "dev-app-6fvh2isn.myshopify.com")) {
  throw new Error("Source fixture must be a successful read of the development shop");
}
const sourceProducts: any[] = sourceSnapshot?.products ?? [];
const endpoint = process.env.AI_SEARCH_LIVE_TEST_URL ?? "";
if (!endpoint) {
  throw new Error(
    "Set AI_SEARCH_LIVE_TEST_URL to the running dev/proxy-e2e endpoint",
  );
}

type Ranked = {
  productId: string;
  handle?: string;
  title?: string;
};

function gid(id: unknown) {
  const value = String(id ?? "");
  return /^\d+$/.test(value) ? `gid://shopify/Product/${value}` : value;
}

function normalized(value: string | null | undefined) {
  return (value ?? "")
    .toLocaleLowerCase("vi-VN")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const FOOTWEAR = /\b(?:shoe|shoes|sneaker|sneakers|loafer|loafers|boot|boots|oxford|oxfords|footwear|giay)\b/i;
const STORAGE_FIXTURE = /\b(?:shelf|shelves|shelving|storage rack|organizer|organiser|bookcase|cabinet|ke|gia do)\b/i;
const BICYCLE_LIGHT = /\b(?:bicycle light|bike light|headlight|tail ?light|front light|rear light|superflash|knog)\b/i;
const BLUE = /\b(?:blue|navy|azure|xanh)\b/i;
const SHIRT_FAMILY = /\b(?:shirt|shirts|tee|t shirt|top|blouse|ao)\b/i;

async function live(query: string) {
  const url = new URL(endpoint);
  url.searchParams.set("q", query);
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  const body = await response.json() as any;
  assert.equal(response.status, 200, `${query}: HTTP must be 200`);
  assert.equal(body.status, "success", `${query}: proxy status must be success`);

  const receiptId = body.render_receipt?.id;
  assert.ok(receiptId, `${query}: missing render receipt`);
  const receipt = await db.aiSearchResultReceipt.findUnique({
    where: { receiptId },
  });
  assert.ok(receipt, `${query}: receipt not persisted`);

  const ranked = JSON.parse(receipt.rankedProductsJson) as Ranked[];
  const ids = ranked.map((row) => gid(row.productId));
  const products = ids.length
    ? await db.aiSearchIndexedProduct.findMany({
        where: {
          shop: receipt.shop,
          productId: { in: ids },
        },
        select: {
          productId: true,
          title: true,
          searchable: true,
          hasVector: true,
        },
      })
    : [];
  const facts = ids.length
    ? await loadProductSemanticRows(receipt.shop, ids)
    : [];

  const productText = (id: string) => {
    const product = products.find((row) => row.productId === id);
    const productFacts = facts
      .filter((row) => row.productId === id)
      .map((row) => `${row.kind}:${row.value}`);
    return normalized([product?.title ?? "", ...productFacts].join(" "));
  };

  return {
    query,
    body,
    receipt,
    ranked,
    ids,
    products,
    facts,
    productText,
  };
}

let failures = 0;
const run = async (query: string, check: (result: Awaited<ReturnType<typeof live>>) => void | "UNKNOWN_DATA") => {
  const started = Date.now();
  try {
    const result = await live(query);
    const verdict = check(result) ?? "PASS";
    console.log(JSON.stringify({
      query,
      verdict,
      total: result.ids.length,
      top: result.ids.slice(0, 8).map((id) =>
        result.products.find((row) => row.productId === id)?.title ?? id,
      ),
      ms: Date.now() - started,
    }));
  } catch (error) {
    failures += 1;
    console.log(JSON.stringify({
      query,
      pass: false,
      error: error instanceof Error ? error.message : String(error),
      ms: Date.now() - started,
    }));
  }
};

try {
  await run("giày size 32", (result) => {
    const sourceCandidates = sourceProducts.filter(product =>
      FOOTWEAR.test(normalized(`${product.title} ${product.productType}`)) &&
      product.options.some((option: any) => /size/i.test(option.name) &&
        option.values.some((value: string) => /(?:^|\s)32(?:$|\s)/.test(value))),
    );
    if (sourceCandidates.length > 0) {
      assert.ok(result.ids.length > 0, "source-grounded footwear size 32 must have recall");
    }
    for (const id of result.ids.slice(0, 20)) {
      const text = result.productText(id);
      assert.match(text, FOOTWEAR, `non-footwear survived target scope: ${text}`);
      assert.match(text, /\b(?:size )?32\b/i, `size-32 fact missing: ${text}`);
    }
    if (sourceCandidates.length === 0 && result.ids.length === 0) return "UNKNOWN_DATA";
  });

  await run("áo xanh", (result) => {
    assert.ok(result.ids.length > 0, "translated shirt/color query must not collapse to zero");
    const top = result.ids.slice(0, 10).map(result.productText);
    assert.ok(
      top.some((text) => SHIRT_FAMILY.test(text)),
      "top results contain no shirt/top family evidence",
    );
    assert.ok(
      top.slice(0, 5).some((text) => BLUE.test(text)),
      "validated blue preference does not affect top ranking",
    );
  });

  await run("kệ để đồ", (result) => {
    const sourceCandidates = sourceProducts.filter(product =>
      STORAGE_FIXTURE.test(normalized(`${product.title} ${product.productType}`)),
    );
    if (sourceCandidates.length > 0) {
      assert.ok(result.ids.length > 0, "source-grounded storage fixture must have recall");
    }
    for (const id of result.ids.slice(0, 10)) {
      const text = result.productText(id);
      assert.match(text, STORAGE_FIXTURE, `wrong target family survived: ${text}`);
    }
    if (sourceCandidates.length === 0 && result.ids.length === 0) return "UNKNOWN_DATA";
  });

  await run("đèn xe đạp", (result) => {
    assert.ok(result.ids.length >= 2, "bicycle-light recall must not collapse to one literal context product");
    const text = result.ids.slice(0, 12).map(result.productText).join(" | ");
    assert.match(text, BICYCLE_LIGHT, "bicycle-light family evidence missing");
    assert.match(text, /\bknog\b/i, "known Knog light recall is still missing");
  });

  await run("gift card", (result) => {
    assert.equal(result.ids.length, 1, "gift card exact control changed unexpectedly");
    assert.match(result.productText(result.ids[0]), /\bgift card\b/i);
  });

  await run("tai nghe", (result) => {
    assert.equal(result.ids.length, 0, "known absent headphone family must remain empty");
  });
} finally {
  await db.$disconnect();
}

assert.equal(failures, 0, "current six-case live relevance regression failed");
console.log("PASS: live ownership/recall assertions; UNKNOWN_DATA availability cases remain unverified");
