-- Recovery now uses updatedAt as the activity heartbeat so a long-running
-- reservation that recently recorded embedding/effect progress is not treated
-- as stale merely because it was created earlier.
CREATE INDEX "AiSearchUsageReservation_shop_status_updatedAt_idx"
  ON "AiSearchUsageReservation"("shop", "status", "updatedAt");

CREATE INDEX "AiSearchUsageReservation_status_updatedAt_idx"
  ON "AiSearchUsageReservation"("status", "updatedAt");

-- Housekeeping removes resolved reservations by status + resolvedAt.
CREATE INDEX "AiSearchUsageReservation_status_resolvedAt_idx"
  ON "AiSearchUsageReservation"("status", "resolvedAt");
