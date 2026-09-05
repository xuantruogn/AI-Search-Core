import type { Config } from "@react-router/dev/config";

function getAllowedActionOrigins(): string[] {
  const appUrl = process.env.SHOPIFY_APP_URL;

  if (!appUrl) {
    return [];
  }

  try {
    return [new URL(appUrl).host];
  } catch {
    return [];
  }
}

export default {
  allowedActionOrigins: getAllowedActionOrigins(),
} satisfies Config;
