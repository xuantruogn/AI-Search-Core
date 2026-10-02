import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  throw redirect("/dev/search-history" + url.search);
}

export default function LegacyDevSearchHistoryRedirect() {
  return null;
}
