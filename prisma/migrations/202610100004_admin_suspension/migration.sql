ALTER TABLE `AiSearchShopSettings`
  ADD COLUMN `adminSuspended` BOOLEAN NOT NULL DEFAULT FALSE;

-- Honor the most recent explicit Dev Center admin suspension from older versions.
UPDATE `AiSearchShopSettings` st
INNER JOIN `AiSearchAdminAuditLog` latest ON latest.id = (
  SELECT a.id FROM `AiSearchAdminAuditLog` a
  WHERE a.targetShop = st.shop
    AND a.action IN ('AI_SEARCH_DISABLED_BY_ADMIN', 'AI_SEARCH_ENABLED_BY_ADMIN')
  ORDER BY a.createdAt DESC, a.id DESC LIMIT 1
)
SET st.adminSuspended = TRUE
WHERE latest.action = 'AI_SEARCH_DISABLED_BY_ADMIN';
