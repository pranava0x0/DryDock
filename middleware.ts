import { NextResponse, type NextRequest } from "next/server";
import {
  decideRequest,
  resolveAuthConfig,
  type RequestFacts,
} from "@/lib/auth/decide";
import { verifyAccessJwt } from "@/lib/auth/cf-access";

/**
 * Every request except Next.js static internals flows through here. The
 * decision logic lives in lib/auth/decide.ts (pure, tested); this file
 * only adapts NextRequest → RequestFacts and Decision → Response.
 *
 * Public paths are allow-listed in code (not the matcher) so the list is
 * greppable and the default for anything new is "authenticated".
 */

const PUBLIC_PATHS = new Set([
  "/auth", // login page — must be reachable to log in
  "/api/auth", // login endpoint — validates the token itself
  "/manifest.json", // PWA install metadata
  "/icon.svg",
  "/favicon.ico",
]);

export const config = {
  matcher: ["/((?!_next/).*)"],
};

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  const authConfig = resolveAuthConfig({
    CF_ACCESS_TEAM_DOMAIN: process.env.CF_ACCESS_TEAM_DOMAIN,
    CF_ACCESS_AUD: process.env.CF_ACCESS_AUD,
    DRYDOCK_AUTH_TOKEN: process.env.DRYDOCK_AUTH_TOKEN,
  });

  const authorization = request.headers.get("authorization");
  const facts: RequestFacts = {
    host: request.headers.get("host"),
    hasCloudflareHeaders:
      request.headers.has("cf-ray") ||
      request.headers.has("cf-connecting-ip"),
    bearerToken: authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : null,
    cookieToken: request.cookies.get("drydock_auth")?.value ?? null,
    accessJwt: request.headers.get("cf-access-jwt-assertion"),
    isApiRequest: pathname.startsWith("/api/"),
  };

  const decision = await decideRequest(authConfig, facts, (jwt) =>
    verifyAccessJwt(jwt, {
      teamDomain: authConfig.teamDomain ?? "",
      aud: authConfig.aud ?? "",
    }),
  );

  switch (decision.action) {
    case "allow":
      return NextResponse.next();
    case "redirect-login": {
      const url = request.nextUrl.clone();
      url.pathname = "/auth";
      url.search = "";
      return NextResponse.redirect(url);
    }
    case "unauthorized":
      return NextResponse.json(
        { error: `Unauthorized: ${decision.reason}` },
        { status: 401 },
      );
    case "closed":
      return NextResponse.json(
        {
          error:
            "DryDock is not reachable remotely until auth is configured. " +
            "Set DRYDOCK_AUTH_TOKEN (or CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD) " +
            "and restart — see docs/setup.md §5.",
        },
        { status: 403 },
      );
  }
}
