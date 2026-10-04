-- Keep only indexes used by the live reservation recovery/retention paths.
-- A minimal shop index is retained because MySQL requires an index for the
-- AiSearchUsageReservation.shop foreign key.
ALTER TABLE `AiSearchUsageReservation`
  ADD INDEX `idx_usage_reservation_shop` (`shop`);

ALTER TABLE `AiSearchUsageReservation`
  DROP INDEX `AiSearchUsageReservation_shop_status_createdAt_idx`,
  DROP INDEX `AiSearchUsageReservation_status_createdAt_idx`,
  DROP INDEX `AiSearchUsageReservation_shop_status_updatedAt_idx`;
