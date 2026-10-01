import { redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";

export async function loader({ request }: LoaderFunctionArgs) {
  void request;
  throw redirect("/dev");
}

export async function action({ request }: ActionFunctionArgs) {
  void request;
  throw new Response("Not found", { status: 404 });
}

export default function LegacyDevDashboardRoute() {
  return null;
}
