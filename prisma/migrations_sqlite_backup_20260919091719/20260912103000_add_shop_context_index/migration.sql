-- CreateTable
CREATE TABLE "AiSearchShopContextTerm" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "normalizedValue" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiSearchShopContextTerm_shop_productId_fkey"
      FOREIGN KEY ("shop", "productId")
      REFERENCES "AiSearchIndexedProduct" ("shop", "productId")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "AiSearchShopContextTerm_shop_productId_kind_normalizedValue_key"
ON "AiSearchShopContextTerm"("shop", "productId", "kind", "normalizedValue");

CREATE INDEX "AiSearchShopContextTerm_shop_kind_idx"
ON "AiSearchShopContextTerm"("shop", "kind");

CREATE INDEX "AiSearchShopContextTerm_shop_normalizedValue_idx"
ON "AiSearchShopContextTerm"("shop", "normalizedValue");
