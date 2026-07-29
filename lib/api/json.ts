import { NextResponse } from "next/server";

/**
 * Tiny helpers to keep the API routes consistent. Every route returns a JSON
 * body either way; these wrappers make sure errors have a `{ error }` shape
 * so the frontend never has to branch on Content-Type.
 */
export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, init);
}

export function created<T>(data: T): NextResponse {
  return NextResponse.json(data, { status: 201 });
}

/** 202: request accepted but the work is parked (e.g. task queued at cap). */
export function accepted<T>(data: T): NextResponse {
  return NextResponse.json(data, { status: 202 });
}

export function badRequest(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}

export function notFound(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 404 });
}

export function conflict(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 409 });
}

/** 429: rate limited. `retryAfterSec` becomes a Retry-After header. */
export function tooManyRequests(
  message: string,
  retryAfterSec?: number,
): NextResponse {
  return NextResponse.json(
    { error: message },
    {
      status: 429,
      headers:
        retryAfterSec !== undefined
          ? { "Retry-After": String(Math.max(1, Math.ceil(retryAfterSec))) }
          : undefined,
    },
  );
}

export function serverError(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 500 });
}
