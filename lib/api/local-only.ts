import { NextResponse, type NextRequest } from "next/server";
import { isLocalRequest } from "../auth/decide";

/**
 * Optional belt-over-auth kill-switch for the dispatch surface.
 *
 * With `DRYDOCK_LOCAL_DISPATCH_ONLY=1`, the routes that can spawn an agent
 * subprocess (/api/sessions, /run, /followup) refuse non-local callers even
 * when they carry valid auth: the phone can still watch streams, browse,
 * and cancel runs, but starting an agent requires being on the Mac itself.
 * Unset (the default), authenticated remote dispatch works as documented.
 *
 * Localness is decided by the same tested predicate the middleware uses —
 * loopback host AND no Cloudflare headers (tunnel traffic always carries
 * cf-ray/cf-connecting-ip, so it can't forge its way past this).
 *
 * Returns null to proceed, or a 403 response to short-circuit the route.
 */
export function rejectRemoteDispatch(request: NextRequest): NextResponse | null {
  if (process.env.DRYDOCK_LOCAL_DISPATCH_ONLY !== "1") return null;
  const local = isLocalRequest({
    // Real HTTP always carries Host (HTTP/2's :authority is mapped to it);
    // the URL fallback exists for hand-built NextRequests in tests.
    host: request.headers.get("host") ?? request.nextUrl.host,
    hasCloudflareHeaders:
      request.headers.has("cf-ray") ||
      request.headers.has("cf-connecting-ip"),
    // isLocalRequest only reads host + hasCloudflareHeaders; the credential
    // fields exist on RequestFacts for the middleware's broader decision.
    bearerToken: null,
    cookieToken: null,
    accessJwt: null,
    isApiRequest: true,
  });
  if (local) return null;
  return NextResponse.json(
    {
      error:
        "Dispatch is limited to this Mac (DRYDOCK_LOCAL_DISPATCH_ONLY=1). " +
        "Viewing and cancelling still work remotely; unset the variable and " +
        "restart to allow remote kickoff.",
    },
    { status: 403 },
  );
}
