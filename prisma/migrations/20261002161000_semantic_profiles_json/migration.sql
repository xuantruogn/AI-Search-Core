CREATE TABLE `AiSearchProductSemanticProfile` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `shop` VARCHAR(191) NOT NULL,
  `productId` VARCHAR(64) NOT NULL,
  `schemaVersion` INTEGER NOT NULL DEFAULT 1,
  `profile` JSON NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `AiSearchProductSemanticProfile_shop_productId_key`(`shop`, `productId`),
  INDEX `AiSearchProductSemanticProfile_shop_updatedAt_idx`(`shop`, `updatedAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `AiSearchProductSemanticProfile_shop_productId_fkey`
    FOREIGN KEY (`shop`, `productId`)
    REFERENCES `AiSearchIndexedProduct`(`shop`, `productId`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `AiSearchProductSemanticProfile`
  (`shop`, `productId`, `schemaVersion`, `profile`, `createdAt`, `updatedAt`)
SELECT
  c.`shop`,
  c.`productId`,
  1,
  JSON_OBJECT(
    'schemaVersion', 1,
    'analysis', NULL,
    'terms', JSON_ARRAYAGG(
      JSON_OBJECT(
        'kind', c.`kind`,
        'value', c.`value`,
        'normalizedValue', c.`normalizedValue`
      )
    )
  ),
  MIN(c.`createdAt`),
  CURRENT_TIMESTAMP(3)
FROM `AiSearchShopContextTerm` c
INNER JOIN `AiSearchIndexedProduct` p
  ON p.`shop` = c.`shop`
 AND p.`productId` = c.`productId`
GROUP BY c.`shop`, c.`productId`;

DROP TABLE `AiSearchShopContextTerm`;
