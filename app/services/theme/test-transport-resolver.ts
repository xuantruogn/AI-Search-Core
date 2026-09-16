import {
  planThemeSearchTransportFromStoredKeys,
} from "./theme-search-transport-key.server";

async function main() {
  const shop =
    "add-get-d-test.myshopify.com";

  const productIds = [
    // Gift Card
    "gid://shopify/Product/10444087230754",

    // Selling Plans Ski Wax
    "gid://shopify/Product/10444087591202",

    // The Multi-managed Snowboard
    "gid://shopify/Product/10444087689506",
  ];

  const plan =
    await planThemeSearchTransportFromStoredKeys({
      shop,
      productIds,
    });

  console.dir(
    plan,
    {
      depth: null,
    },
  );
}

main().catch(
  (error) => {
    console.error(
      error,
    );

    process.exitCode =
      1;
  },
);