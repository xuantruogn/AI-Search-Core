import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { markShopUninstalled } from "../services/commerce/shop-registry.server";
import { invalidateThemeMapV4 } from "../services/theme/theme-map-v4-lifecycle.server";

function hasValidShopifyHmac(
  rawBody: string,
  providedHmac: string | null,
): boolean {
  const secret = process.env.SHOPIFY_API_SECRET;

  if (!secret || !providedHmac) {
    return false;
  }

  const expected = createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");

  const provided = Buffer.from(providedHmac, "base64");
  const expectedBuffer = Buffer.from(expected, "base64");

  return (
    provided.length === expectedBuffer.length &&
    timingSafeEqual(provided, expectedBuffer)
  );
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const requestUrl = new URL(request.url);

  /*
   * Keep a clone because authenticate.webhook() may consume the request body.
   *
   * Shopify's app/uninstalled webhook is special when expiring offline access
   * tokens are enabled: the SDK can try to refresh a token that Shopify has
   * just revoked, throw a bare 500, and never reach this handler. We therefore
   * keep a session-independent HMAC fallback for this webhook only.
   */
  const rawBody = await request.clone().text();

  const webhookHeaders = {
    topic: request.headers.get("x-shopify-topic"),
    shop: request.headers.get("x-shopify-shop-domain"),
    webhookId: request.headers.get("x-shopify-webhook-id"),
    apiVersion: request.headers.get("x-shopify-api-version"),
  };

  console.log("[AI Search][UNINSTALL TRACE] request received", {
    method: request.method,
    pathname: requestUrl.pathname,
    ...webhookHeaders,
  });

  if (
    webhookHeaders.topic === "app/uninstalled" &&
    !hasValidShopifyHmac(
      rawBody,
      request.headers.get("x-shopify-hmac-sha256"),
    )
  ) {
    console.error("[AI Search][UNINSTALL TRACE] invalid Shopify HMAC", {
      shop: webhookHeaders.shop,
      webhookId: webhookHeaders.webhookId,
    });

    return new Response("Unauthorized", { status: 401 });
  }

  let shop: string;
  let topic: string;

  try {
    const authenticated = await authenticate.webhook(request);
    shop = authenticated.shop;
    topic = authenticated.topic;

    console.log("[AI Search][UNINSTALL TRACE] webhook authenticated", {
      shop,
      topic,
      webhookId: webhookHeaders.webhookId,
    });
  } catch (error) {
    /*
     * IMPORTANT:
     * Do not disable expiringOfflineAccessTokens just to make uninstall work.
     * Shopify revokes the shop's token as part of uninstall, while the current
     * React Router SDK 1.2.1 can attempt a refresh before returning the webhook
     * context. For app/uninstalled, HMAC + headers are sufficient to process
     * the event and no Admin API session is required.
     */
    if (
      webhookHeaders.topic === "app/uninstalled" &&
      webhookHeaders.shop &&
      hasValidShopifyHmac(
        rawBody,
        request.headers.get("x-shopify-hmac-sha256"),
      )
    ) {
      shop = webhookHeaders.shop;
      topic = "APP_UNINSTALLED";

      console.warn(
        "[AI Search][UNINSTALL TRACE] SDK webhook auth failed; using verified sessionless uninstall fallback",
        {
          shop,
          topic,
          webhookId: webhookHeaders.webhookId,
          error: error instanceof Error
            ? { name: error.name, message: error.message }
            : error,
        },
      );
    } else {
      console.error(
        "[AI Search][UNINSTALL TRACE] webhook authentication failed",
        {
          ...webhookHeaders,
          error: error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : error,
        },
      );
      throw error;
    }
  }

  console.log(`[AI Search] Received ${topic} webhook for ${shop}`);

  /**
   * Reinstall cho cùng shop phải bắt đầu lại từ MAIN theme hiện tại tại thời
   * điểm cài lại app. Vì vậy cần dọn RAM cache Theme Map V4 ngay trong process.
   *
   * Bước này KHÔNG còn dùng Theme Map V3.
   */
  invalidateThemeMapV4(shop);

  try {
    console.log("[AI Search][UNINSTALL TRACE] markShopUninstalled:start", {
      shop,
    });

    await markShopUninstalled(shop);

    const shopAfterUninstall = await db.aiSearchShop.findUnique({
      where: { shop },
      select: {
        status: true,
        installedAt: true,
        uninstalledAt: true,
        currentPlanHandle: true,
        currentSubscriptionGid: true,
        pendingPlanHandle: true,
        pendingSubscriptionGid: true,
      },
    });

    console.log("[AI Search][UNINSTALL TRACE] markShopUninstalled:done", {
      shop,
      dbState: shopAfterUninstall,
    });
  } catch (error) {
    // Older Phase-1 databases may receive uninstall before the commercial
    // migration is deployed. Session cleanup must still succeed.
    console.error("[AI Search] Failed to mark shop uninstalled:", error);
  }

  try {
    const deletedSessions = await db.session.deleteMany({ where: { shop } });

    console.log("[AI Search][UNINSTALL TRACE] session cleanup:done", {
      shop,
      deletedCount: deletedSessions.count,
    });
  } catch (error) {
    console.error(
      "[AI Search][UNINSTALL TRACE] session cleanup failed",
      {
        shop,
        error: error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : error,
      },
    );
    throw error;
  }

  console.log("[AI Search][UNINSTALL TRACE] completed", {
    shop,
    topic,
    webhookId: webhookHeaders.webhookId,
  });

  return new Response("OK", { status: 200 });
};
