function enabled() {
  return process.env.AI_SEARCH_DEV_DASHBOARD_ENABLED?.trim().toLowerCase() === "true";
}

function allowedShops() {
  return new Set(
    (process.env.AI_SEARCH_DEV_ADMIN_SHOPS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function canAccessDevDashboard(shop: string) {
  return enabled() && allowedShops().has(shop.trim().toLowerCase());
}

export function assertDevDashboardAccess(shop: string) {
  if (!canAccessDevDashboard(shop)) {
    throw new Response("Not found", { status: 404 });
  }
}
