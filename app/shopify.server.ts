import "@shopify/shopify-app-react-router/adapters/node";

import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";

import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";

import prisma from "./db.server";
import { syncThemeMapV4AfterInstall } from "./services/theme/theme-map-v4-install.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,

  apiSecretKey:
    process.env.SHOPIFY_API_SECRET || "",

  apiVersion:
    ApiVersion.July26,

  scopes:
    process.env.SCOPES?.split(","),

  appUrl:
    process.env.SHOPIFY_APP_URL || "",

  authPathPrefix:
    "/auth",

  sessionStorage:
    new PrismaSessionStorage(prisma),

  distribution:
    AppDistribution.AppStore,

  hooks: {
    afterAuth: async ({
      admin,
      session,
    }) => {
      /*
       * Theme Map V4 initial bootstrap.
       *
       * Không chạy trong storefront search.
       * Không chạy mỗi query.
       *
       * Đây là lifecycle sau khi Shopify
       * authentication/install hoàn tất.
       *
       * Sau này merchant đổi theme thì phải
       * chủ động bấm "Đồng bộ theme".
       */
      await syncThemeMapV4AfterInstall({
        admin,
        shop: session.shop,
      });
    },
  },

  future: {
    expiringOfflineAccessTokens:
      true,
  },

  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? {
        customShopDomains: [
          process.env.SHOP_CUSTOM_DOMAIN,
        ],
      }
    : {}),
});

export default shopify;

export const apiVersion =
  ApiVersion.July26;

export const addDocumentResponseHeaders =
  shopify.addDocumentResponseHeaders;

export const authenticate =
  shopify.authenticate;

export const unauthenticated =
  shopify.unauthenticated;

export const login =
  shopify.login;

export const registerWebhooks =
  shopify.registerWebhooks;

export const sessionStorage =
  shopify.sessionStorage;