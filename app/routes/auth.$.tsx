import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const startedAt = Date.now();
  const url = new URL(request.url);

  console.log("[AUTH ROUTE START]", {
    at: new Date().toISOString(),
    method: request.method,
    url: request.url,
    pathname: url.pathname,
    searchParams: [...url.searchParams.keys()],
    referer: request.headers.get("referer"),
    secFetchDest: request.headers.get("sec-fetch-dest"),
    secFetchMode: request.headers.get("sec-fetch-mode"),
    userAgent: request.headers.get("user-agent"),
  });

  console.log("[AUTH ROUTE AUTHENTICATE START]", {
    at: new Date().toISOString(),
    pathname: url.pathname,
  });

  try {
    const result = await authenticate.admin(request);

    console.log("[AUTH ROUTE AUTHENTICATE DONE]", {
      at: new Date().toISOString(),
      pathname: url.pathname,
      shop: result.session.shop,
      elapsedMs: Date.now() - startedAt,
    });

    return null;
  } catch (error) {
    console.error("[AUTH ROUTE AUTHENTICATE ERROR]", {
      at: new Date().toISOString(),
      pathname: url.pathname,
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
