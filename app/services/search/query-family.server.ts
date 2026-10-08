import { normalizeQueryText } from "./deterministic-query-parser.server";

// Shared broad-family policy for parser and semantic adapter. These nouns
// describe discovery breadth, never a catalog leaf or hard product scope.
const GENERIC_DISCOVERY_FAMILIES = new Set([
  "apparel", "clothing", "clothes", "fashion", "gear", "equipment",
  "accessory", "accessories", "outfit", "outfits", "product", "products",
  "item", "items",
]);
export function isGenericDiscoveryFamily(value: string) {
  const normalized = normalizeQueryText(value);
  return Boolean(normalized) &&
    GENERIC_DISCOVERY_FAMILIES.has(normalized.split(" ").at(-1)!);
}
