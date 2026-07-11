/**
 * Cloudflare Access JWT verification, dependency-free (WebCrypto only) so
 * it runs on the middleware's edge runtime.
 *
 * Access stamps every request it lets through with `Cf-Access-Jwt-Assertion`,
 * an RS256 JWT. We verify: signature against the team's published JWKS,
 * `iss` matches the team domain, `aud` contains our application AUD, and
 * the token hasn't expired. Anything short of all four is a reject.
 *
 * JWKS is cached in-module for 10 minutes; an unknown `kid` forces one
 * refetch (key rotation) before failing.
 */

interface Jwk {
  kid?: string;
  kty: string;
  alg?: string;
  n?: string;
  e?: string;
}

export interface VerifyOptions {
  /** e.g. "myteam" or "myteam.cloudflareaccess.com" */
  teamDomain: string;
  /** The Access application's audience tag. */
  aud: string;
  /** Injectable clock (seconds) for tests. */
  nowSeconds?: number;
  /** Injectable JWKS fetcher for tests. */
  fetchJwks?: (url: string) => Promise<{ keys: Jwk[] }>;
}

export function normalizeTeamDomain(raw: string): string {
  const trimmed = raw.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return trimmed.includes(".") ? trimmed : `${trimmed}.cloudflareaccess.com`;
}

interface JwksCache {
  url: string;
  keys: Map<string, Jwk>;
  fetchedAt: number;
}

let jwksCache: JwksCache | null = null;
const JWKS_TTL_MS = 10 * 60 * 1000;

/** Test hook — clears the module-level JWKS cache. */
export function _resetJwksCacheForTests(): void {
  jwksCache = null;
}

async function defaultFetchJwks(url: string): Promise<{ keys: Jwk[] }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  return (await res.json()) as { keys: Jwk[] };
}

async function getKey(
  kid: string,
  certsUrl: string,
  fetchJwks: (url: string) => Promise<{ keys: Jwk[] }>,
): Promise<Jwk | null> {
  const fresh =
    jwksCache !== null &&
    jwksCache.url === certsUrl &&
    Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS;
  if (!fresh || !jwksCache?.keys.has(kid)) {
    const { keys } = await fetchJwks(certsUrl);
    jwksCache = {
      url: certsUrl,
      keys: new Map(keys.filter((k) => k.kid).map((k) => [k.kid as string, k])),
      fetchedAt: Date.now(),
    };
  }
  return jwksCache.keys.get(kid) ?? null;
}

function b64urlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function decodeJson(b64url: string): Record<string, unknown> | null {
  try {
    const text = new TextDecoder().decode(b64urlToBytes(b64url));
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Verify a Cloudflare Access assertion. Returns false on ANY defect —
 * malformed structure, unknown key, bad signature, wrong iss/aud, expired.
 * Never throws on untrusted input; a network failure fetching JWKS also
 * verifies false (fail closed).
 */
export async function verifyAccessJwt(
  jwt: string,
  options: VerifyOptions,
): Promise<boolean> {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return false;
    const [headerB64, payloadB64, signatureB64] = parts;

    const header = decodeJson(headerB64);
    if (!header || header.alg !== "RS256") return false;
    const kid = typeof header.kid === "string" ? header.kid : null;
    if (!kid) return false;

    const payload = decodeJson(payloadB64);
    if (!payload) return false;

    const teamDomain = normalizeTeamDomain(options.teamDomain);
    const certsUrl = `https://${teamDomain}/cdn-cgi/access/certs`;
    const jwk = await getKey(
      kid,
      certsUrl,
      options.fetchJwks ?? defaultFetchJwks,
    );
    if (!jwk || jwk.kty !== "RSA") return false;

    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const sig = b64urlToBytes(signatureB64);
    const validSignature = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      sig as BufferSource,
      data,
    );
    if (!validSignature) return false;

    // Claims — checked only after the signature proves they're Cloudflare's.
    const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (payload.iss !== `https://${teamDomain}`) return false;
    const aud = payload.aud;
    const audOk = Array.isArray(aud)
      ? aud.includes(options.aud)
      : aud === options.aud;
    if (!audOk) return false;
    if (typeof payload.exp !== "number" || payload.exp <= now) return false;
    if (typeof payload.nbf === "number" && payload.nbf > now) return false;

    return true;
  } catch {
    return false;
  }
}
