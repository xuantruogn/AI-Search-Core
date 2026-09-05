import { createHash } from "node:crypto";

/**
 * Qdrant point IDs share one collection across all Shopify stores.
 * Shopify resource numeric IDs must therefore never be used as a tenant-global
 * key. Build a deterministic UUID from both shop + product GID instead.
 */
export function getTenantProductVectorPointId(
  shop: string,
  productId: string,
): string {
  const cleanShop = shop.trim().toLowerCase();
  const cleanProductId = productId.trim();

  if (!cleanShop || !cleanProductId) {
    throw new Error("Shop and productId are required for a Qdrant point ID");
  }

  const bytes = Buffer.from(
    createHash("sha256")
      .update(`${cleanShop}\u0000${cleanProductId}`, "utf8")
      .digest()
      .subarray(0, 16),
  );

  // Produce a canonical UUID. The hash is deterministic; version/variant bits
  // are set only so Qdrant's UUID parser receives a standards-shaped value.
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Legacy Phase-1 numeric ID, used only for migration/cleanup. */
export function getLegacyNumericProductPointId(
  productId: string,
): number | null {
  const rawId = productId.split("/").pop();
  if (!rawId) return null;
  const value = Number(rawId);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
