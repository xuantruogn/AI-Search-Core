CREATE TABLE "AiSearchUsageReservation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shop" TEXT NOT NULL,
  "periodId" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "countsVectorUpdate" BOOLEAN NOT NULL DEFAULT false,
  "productId" TEXT,
  "queryHash" TEXT,
  "embeddingConsumedAt" DATETIME,
  "effectAppliedAt" DATETIME,
  "resolvedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiSearchUsageReservation_shop_fkey"
    FOREIGN KEY ("shop") REFERENCES "AiSearchShop" ("shop")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AiSearchUsageReservation_periodId_fkey"
    FOREIGN KEY ("periodId") REFERENCES "AiSearchUsagePeriod" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "AiSearchUsageReservation_shop_status_createdAt_idx"
  ON "AiSearchUsageReservation"("shop", "status", "createdAt");
CREATE INDEX "AiSearchUsageReservation_status_createdAt_idx"
  ON "AiSearchUsageReservation"("status", "createdAt");
CREATE INDEX "AiSearchUsageReservation_periodId_status_idx"
  ON "AiSearchUsageReservation"("periodId", "status");
