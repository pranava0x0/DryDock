import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { tokensMatch } from "@/lib/auth/decide";
import { badRequest, ok } from "@/lib/api/json";

export const runtime = "nodejs";

const COOKIE_NAME = "drydock_auth";
const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60; // 30 days — PWA shouldn't nag

/**
 * Token-mode login. Validates the presented token against
 * DRYDOCK_AUTH_TOKEN and sets the httpOnly session cookie the middleware
 * accepts. This route is on the middleware's public list — it has to be,
 * or nobody could ever log in — so it must never leak anything on failure.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const expected = process.env.DRYDOCK_AUTH_TOKEN?.trim();
  if (!expected) {
    // Token mode isn't enabled (cf-access or closed). 404 shape keeps the
    // endpoint from advertising which auth mode is live.
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON");
  }
  const token =
    typeof (body as Record<string, unknown>)?.token === "string"
      ? ((body as Record<string, unknown>).token as string)
      : "";

  if (!token || !(await tokensMatch(token, expected))) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const response = ok({ authenticated: true });
  response.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_S,
    // Secure over the tunnel (https); localhost dev stays plain http.
    secure: request.nextUrl.protocol === "https:" ||
      request.headers.get("x-forwarded-proto") === "https",
  });
  return response;
}

/** Logout — clears the session cookie. */
export async function DELETE(): Promise<Response> {
  const response = ok({ authenticated: false });
  response.cookies.set(COOKIE_NAME, "", { path: "/", maxAge: 0 });
  return response;
}
