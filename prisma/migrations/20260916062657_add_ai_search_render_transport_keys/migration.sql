-- CreateTable
CREATE TABLE "AiSearchRenderTransportKey" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "clause" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "AiSearchRenderTransportKey_shop_kind_signature_idx" ON "AiSearchRenderTransportKey"("shop", "kind", "signature");

-- CreateIndex
CREATE INDEX "AiSearchRenderTransportKey_shop_productId_idx" ON "AiSearchRenderTransportKey"("shop", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "AiSearchRenderTransportKey_shop_productId_kind_signature_key" ON "AiSearchRenderTransportKey"("shop", "productId", "kind", "signature");
