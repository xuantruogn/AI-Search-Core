import type { Config } from "@react-router/dev/config";

function getAllowedActionOrigins(): string[] {
  const values = [
    process.env.SHOPIFY_APP_URL,
    ...(process.env.DEV_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ];

  return Array.from(
    new Set(
      values.flatMap((value) => {
        if (!value) return [];
        try {
          return [new URL(value).host];
        } catch {
          return [];
        }
      }),
    ),
  );
}

export default {
  allowedActionOrigins: getAllowedActionOrigins(),
} satisfies Config;
