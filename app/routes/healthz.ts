import db from "../db.server";

export const loader = async () => {
  try {
    await db.$queryRaw`SELECT 1`;

    return Response.json(
      {
        status: "ok",
        service: "ai-search-bridge",
        database: "ok",
        timestamp: new Date().toISOString(),
      },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    console.error("[AI Search] Health check failed:", error);

    return Response.json(
      {
        status: "error",
        service: "ai-search-bridge",
        database: "error",
        timestamp: new Date().toISOString(),
      },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  }
};
