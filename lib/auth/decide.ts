/**
 * Auth decision logic for the middleware. Pure and edge-safe: no Node
 * imports, no DB — everything the decision needs is passed in, so the
 * whole policy is unit-testable without a running server.
 *
 * Threat model: the Cloudflare Tunnel URL used to be a completely open
 * remote-code-execution endpoint (DD-BL-07). The middleware closes it with
 * one of two modes, chosen by env config:
 *
 * - `cf-access`: Cloudflare Access fronts the tunnel; we verify the
 *   `Cf-Access-Jwt-Assertion` JWT it stamps on every request.
 * - `token`: a single shared secret (`DRYDOCK_AUTH_TOKEN`), presented as a
 *   Bearer header (curl/scripts) or an httpOnly cookie set by /auth (PWA).
 * - `closed`: neither configured → every non-local request is denied.
 *   Fail closed, never open.
 *
 * Requests from the Mac itself (localhost) bypass auth — but only when no
 * Cloudflare headers are present. Traffic that transits the tunnel always
 * carries cf-ray/cf-connecting-ip stamped by the edge, so an attacker
 * can't unlock the bypass by sending `Host: localhost` through the tunnel.
 */

export type AuthMode = "cf-access" | "token" | "closed";

export interface AuthConfig {
  mode: AuthMode;
  /** token mode */
  expectedToken?: string;
  /** cf-access mode */
  teamDomain?: string;
  aud?: string;
}

export interface AuthEnv {
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  DRYDOCK_AUTH_TOKEN?: string;
}

export function resolveAuthConfig(env: AuthEnv): AuthConfig {
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN?.trim();
  const aud = env.CF_ACCESS_AUD?.trim();
  if (teamDomain && aud) return { mode: "cf-access", teamDomain, aud };
  const token = env.DRYDOCK_AUTH_TOKEN?.trim();
  if (token) return { mode: "token", expectedToken: token };
  return { mode: "closed" };
}

export interface RequestFacts {
  /** Host header (may include port). */
  host: string | null;
  /** cf-ray / cf-connecting-ip present → request transited Cloudflare. */
  hasCloudflareHeaders: boolean;
  /** Authorization: Bearer <token>, already stripped. */
  bearerToken: string | null;
  /** drydock_auth cookie value. */
  cookieToken: string | null;
  /** Cf-Access-Jwt-Assertion header. */
  accessJwt: string | null;
  /** Path starts with /api/ → deny with 401 JSON, never a login redirect. */
  isApiRequest: boolean;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLocalRequest(facts: RequestFacts): boolean {
  if (facts.hasCloudflareHeaders) return false;
  if (!facts.host) return false;
  // Strip the port; [::1]:3000 keeps its brackets.
  const host = facts.host.replace(/:\d+$/, "").toLowerCase();
  return LOCAL_HOSTS.has(host);
}

/**
 * Compare two secrets without a data-dependent early exit. Hashing first
 * equalizes lengths; the XOR fold over the digests never short-circuits.
 */
export async function tokensMatch(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

export type Decision =
  | { action: "allow" }
  /** 401 — bad/missing credentials on an API request (or any cf-access miss). */
  | { action: "unauthorized"; reason: string }
  /** Page request in token mode without a cookie → send to /auth. */
  | { action: "redirect-login" }
  /** No auth configured and the request isn't local → refuse with a hint. */
  | { action: "closed" };

export async function decideRequest(
  config: AuthConfig,
  facts: RequestFacts,
  verifyAccessJwt: (jwt: string) => Promise<boolean>,
): Promise<Decision> {
  if (isLocalRequest(facts)) return { action: "allow" };

  switch (config.mode) {
    case "cf-access": {
      // If Access fronts the tunnel, every legitimate request carries the
      // assertion header. Reaching here without a valid one means either a
      // misconfigured Access policy or someone dialing the origin directly
      // — both get a hard 401, there is no login page to offer.
      if (facts.accessJwt && (await verifyAccessJwt(facts.accessJwt))) {
        return { action: "allow" };
      }
      return {
        action: "unauthorized",
        reason: facts.accessJwt
          ? "Cloudflare Access assertion failed verification"
          : "missing Cloudflare Access assertion",
      };
    }
    case "token": {
      const expected = config.expectedToken ?? "";
      const presented = facts.bearerToken ?? facts.cookieToken;
      if (presented && (await tokensMatch(presented, expected))) {
        return { action: "allow" };
      }
      if (facts.isApiRequest) {
        return { action: "unauthorized", reason: "missing or invalid token" };
      }
      return { action: "redirect-login" };
    }
    case "closed":
      return { action: "closed" };
  }
}
