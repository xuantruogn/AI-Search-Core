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
    const isResponse =
      error instanceof Response ||
      (typeof error === "object" &&
        error !== null &&
        "status" in error &&
        "headers" in error);

    if (isResponse) {
      const response = error as Response;
      const location = response.headers.get("location");
      const locationInfo = location
        ? (() => {
            try {
              const locationUrl = new URL(location, request.url);
              return {
                pathname: locationUrl.pathname,
                searchParams: [...locationUrl.searchParams.keys()],
              };
            } catch {
              return { invalidLocation: true };
            }
          })()
        : null;

      console.error("[AUTH ROUTE AUTHENTICATE RESPONSE]", {
        at: new Date().toISOString(),
        method: request.method,
        pathname: url.pathname,
        elapsedMs: Date.now() - startedAt,
        responseStatus: response.status,
        responseStatusText: response.statusText,
        responseUrl: response.url || null,
        responseType: response.type,
        responseRedirected: response.redirected,
        location: locationInfo,
        responseHeaders: {
          location: locationInfo,
          contentType: response.headers.get("content-type"),
          cacheControl: response.headers.get("cache-control"),
          vary: response.headers.get("vary"),
          wwwAuthenticate: response.headers.get("www-authenticate"),
          xRequestId: response.headers.get("x-request-id"),
          xShopifyRequestId: response.headers.get("x-shopify-request-id"),
        },
      });
    } else {
      console.error("[AUTH ROUTE AUTHENTICATE ERROR]", {
        at: new Date().toISOString(),
        pathname: url.pathname,
        elapsedMs: Date.now() - startedAt,
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }

    throw error;
  }
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
