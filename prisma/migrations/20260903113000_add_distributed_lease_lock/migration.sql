-- Distributed lease locks for cross-process product synchronization and future
-- maintenance tasks. Rows are short-lived and released after each task.
CREATE TABLE "AiSearchLeaseLock" (
    "shop" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "ownerToken" TEXT NOT NULL,
    "leaseUntil" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,

    PRIMARY KEY ("shop", "resource")
);

CREATE INDEX "AiSearchLeaseLock_leaseUntil_idx"
ON "AiSearchLeaseLock"("leaseUntil");
