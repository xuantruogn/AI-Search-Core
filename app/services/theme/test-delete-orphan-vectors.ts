import {
  deleteProductVectorForShop,
  getProductVectorForShop,
} from "../search/vector-store.server";

async function main() {
  const shop =
    "add-get-d-test.myshopify.com";

  const productIds = [
    "gid://shopify/Product/10444087460130",
    "gid://shopify/Product/10461011673378",
  ];

  for (const productId of productIds) {
    const before =
      await getProductVectorForShop({
        shop,
        productId,
        withVector: false,
      });

    console.log("\nBEFORE:", {
      productId,
      exists: Boolean(before),
      payload: before?.payload ?? null,
    });

    await deleteProductVectorForShop({
      shop,
      productId,
    });

    const after =
      await getProductVectorForShop({
        shop,
        productId,
        withVector: false,
      });

    console.log("AFTER:", {
      productId,
      exists: Boolean(after),
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});