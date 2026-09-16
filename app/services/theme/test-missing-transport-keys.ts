import db from "../../db.server";

async function main() {
  const shop =
    "add-get-d-test.myshopify.com";

  const productIds = [
    "gid://shopify/Product/10444087460130",
    "gid://shopify/Product/10461011673378",
  ];

  const indexedProducts =
    await db.aiSearchIndexedProduct.findMany({
      where: {
        shop,
        productId: {
          in: productIds,
        },
      },
      orderBy: {
        productId: "asc",
      },
    });

  const transportKeys =
    await db.aiSearchRenderTransportKey.findMany({
      where: {
        shop,
        productId: {
          in: productIds,
        },
      },
      orderBy: [
        {
          productId: "asc",
        },
        {
          kind: "asc",
        },
      ],
    });

  console.log(
    "\n=== INDEXED PRODUCTS ===",
  );

  console.dir(
    indexedProducts,
    {
      depth: null,
    },
  );

  console.log(
    "\n=== TRANSPORT KEYS ===",
  );

  console.dir(
    transportKeys,
    {
      depth: null,
    },
  );

  console.log(
    "\n=== SUMMARY ===",
  );

  for (
    const productId
    of productIds
  ) {
    const indexed =
      indexedProducts.find(
        (row) =>
          row.productId ===
          productId,
      );

    const keys =
      transportKeys.filter(
        (row) =>
          row.productId ===
          productId,
      );

    console.log({
      productId,

      indexedRow:
        Boolean(indexed),

      hasVector:
        indexed?.hasVector ??
        null,

      handle:
        indexed?.handle ??
        null,

      title:
        indexed?.title ??
        null,

      lastIndexedAt:
        indexed?.lastIndexedAt ??
        null,

      lastCatalogSeenAt:
        indexed?.lastCatalogSeenAt ??
        null,

      transportKeyCount:
        keys.length,
    });
  }
}

main()
  .catch(
    (error) => {
      console.error(
        error,
      );

      process.exitCode =
        1;
    },
  )
  .finally(
    async () => {
      await db.$disconnect();
    },
  );