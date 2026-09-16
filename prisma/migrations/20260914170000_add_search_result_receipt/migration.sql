CREATE TABLE "AiSearchResultReceipt" (
    "receiptId" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "rankedProductsJson" TEXT NOT NULL,
    "total" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL
);

CREATE INDEX "AiSearchResultReceipt_shop_expiresAt_idx"
ON "AiSearchResultReceipt"("shop", "expiresAt");

CREATE INDEX "AiSearchResultReceipt_expiresAt_idx"
ON "AiSearchResultReceipt"("expiresAt");
