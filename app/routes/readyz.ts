import { getReadiness } from "../services/maintenance/readiness.server";
export async function loader() {
  const readiness = await getReadiness();
  return Response.json(readiness, { status: readiness.status === "READY" ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
