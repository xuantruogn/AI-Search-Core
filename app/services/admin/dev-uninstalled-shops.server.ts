import db from "../../db.server";

export type DevUninstalledShop = {
  shop: string;
  uninstalledAt: string;
  previousStatus: string | null;
  currentPlanHandle: string | null;
  subscriptionStatus: string | null;
  subscriptionGid: string | null;
  webhookId: string | null;
  eventOccurredAt: string | null;
};

export async function getDevUninstalledShopsData(search = "") {
  const needle = search.trim().toLowerCase();

  const shops = await db.aiSearchShop.findMany({
    where: {
      status: "UNINSTALLED",
      ...(needle
        ? {
            shop: {
              contains: needle,
            },
          }
        : {}),
    },
    orderBy: [
      { uninstalledAt: "desc" },
      { updatedAt: "desc" },
    ],
    take: 500,
    select: {
      shop: true,
      status: true,
      uninstalledAt: true,
      currentPlanHandle: true,
      currentSubscriptionGid: true,
      billingSubscriptions: {
        orderBy: { updatedAt: "desc" },
        take: 1,
        select: {
          status: true,
          plan: {
            select: {
              handle: true,
              name: true,
            },
          },
        },
      },
      billingEvents: {
        where: { type: "APP_UNINSTALLED" },
        orderBy: { occurredAt: "desc" },
        take: 1,
        select: {
          subscriptionGid: true,
          idempotencyKey: true,
          payload: true,
          occurredAt: true,
        },
      },
    },
  });

  return {
    generatedAt: new Date().toISOString(),
    query: search,
    shops: shops.map((shop) => {
      const event = shop.billingEvents[0];
      const payload =
        event?.payload && typeof event.payload === "object"
          ? (event.payload as Record<string, unknown>)
          : null;

      return {
        shop: shop.shop,
        uninstalledAt: shop.uninstalledAt?.toISOString() ?? "",
        previousStatus:
          typeof payload?.previousShopStatus === "string"
            ? payload.previousShopStatus
            : null,
        currentPlanHandle: shop.currentPlanHandle,
        subscriptionStatus: shop.billingSubscriptions[0]?.status ?? null,
        subscriptionGid:
          event?.subscriptionGid ??
          shop.currentSubscriptionGid ??
          null,
        webhookId:
          typeof payload?.webhookId === "string" ? payload.webhookId : null,
        eventOccurredAt: event?.occurredAt.toISOString() ?? null,
      } satisfies DevUninstalledShop;
    }),
  };
}
