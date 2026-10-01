ALTER TABLE `plan_assignments`
  ADD COLUMN `customMaxIndexedProducts` INTEGER NULL,
  ADD COLUMN `customMaxMonthlySearches` INTEGER NULL,
  ADD COLUMN `customMaxMonthlyVectorUpdates` INTEGER NULL;
