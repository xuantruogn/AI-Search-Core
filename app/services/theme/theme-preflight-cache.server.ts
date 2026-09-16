import db from "../../db.server";

export async function clearShopThemeCache(shop: string) {
  try {
    await db.shopThemeConfig.deleteMany({ where: { shop } });
  } catch (error) {
    console.error(`[AI Search] Clear SQLite theme cache failed for shop ${shop}:`, error);
  }
}
