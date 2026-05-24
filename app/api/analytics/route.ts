import { getAnalyticsSummary } from "@/lib/db/analytics";
import { ok, serverError } from "@/lib/api/json";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    return ok(getAnalyticsSummary());
  } catch (err) {
    return serverError((err as Error).message);
  }
}
