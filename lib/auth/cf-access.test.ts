import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetJwksCacheForTests,
  normalizeTeamDomain,
  verifyAccessJwt,
} from "./cf-access";

/**
 * Real RS256 round-trip: generate a keypair, publish the public half as a
 * JWKS, sign assertions with the private half, and verify. No mocked
 * crypto — if WebCrypto semantics change under us, these fail.
 */

const TEAM = "myteam";
const ISS = `https://${TEAM}.cloudflareaccess.com`;
const AUD = "test-aud-tag";
const NOW = 1_800_000_000;

let keyPair: CryptoKeyPair;
let publicJwk: JsonWebKey;

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlJson(obj: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

async function signJwt(
  payload: Record<string, unknown>,
  options: { kid?: string; alg?: string } = {},
): Promise<string> {
  const header = { alg: options.alg ?? "RS256", kid: options.kid ?? "key-1" };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(new Uint8Array(signature))}`;
}

function goodPayload(overrides: Record<string, unknown> = {}) {
  return { iss: ISS, aud: [AUD], exp: NOW + 3600, nbf: NOW - 60, ...overrides };
}

const fetchJwks = async () => ({
  keys: [{ ...publicJwk, kid: "key-1", kty: "RSA" } as never],
});

function verify(jwt: string, fetcher = fetchJwks) {
  return verifyAccessJwt(jwt, {
    teamDomain: TEAM,
    aud: AUD,
    nowSeconds: NOW,
    fetchJwks: fetcher,
  });
}

beforeEach(async () => {
  _resetJwksCacheForTests();
  keyPair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("normalizeTeamDomain", () => {
  it("expands a bare team name and strips scheme/slashes", () => {
    expect(normalizeTeamDomain("myteam")).toBe("myteam.cloudflareaccess.com");
    expect(normalizeTeamDomain("https://myteam.cloudflareaccess.com/")).toBe(
      "myteam.cloudflareaccess.com",
    );
  });
});

describe("verifyAccessJwt", () => {
  it("accepts a valid assertion", async () => {
    expect(await verify(await signJwt(goodPayload()))).toBe(true);
  });

  it("accepts aud as a plain string too", async () => {
    expect(await verify(await signJwt(goodPayload({ aud: AUD })))).toBe(true);
  });

  it("rejects an expired assertion", async () => {
    expect(
      await verify(await signJwt(goodPayload({ exp: NOW - 1 }))),
    ).toBe(false);
  });

  it("rejects wrong audience and wrong issuer", async () => {
    expect(
      await verify(await signJwt(goodPayload({ aud: ["other"] }))),
    ).toBe(false);
    expect(
      await verify(await signJwt(goodPayload({ iss: "https://evil.example" }))),
    ).toBe(false);
  });

  it("rejects a tampered payload (signature mismatch)", async () => {
    const jwt = await signJwt(goodPayload());
    const [h, , s] = jwt.split(".");
    const forged = `${h}.${b64urlJson(goodPayload({ sub: "attacker" }))}.${s}`;
    expect(await verify(forged)).toBe(false);
  });

  it("rejects unknown kid, non-RS256, and malformed tokens", async () => {
    expect(await verify(await signJwt(goodPayload(), { kid: "nope" }))).toBe(
      false,
    );
    expect(
      await verify(await signJwt(goodPayload(), { alg: "none" })),
    ).toBe(false);
    expect(await verify("not-a-jwt")).toBe(false);
    expect(await verify("a.b")).toBe(false);
    expect(await verify("")).toBe(false);
  });

  it("fails closed when the JWKS fetch fails", async () => {
    const jwt = await signJwt(goodPayload());
    expect(
      await verify(jwt, async () => {
        throw new Error("network down");
      }),
    ).toBe(false);
  });

  it("bounds unknown-kid refetches to one per cooldown, still picks up rotation", async () => {
    let fetches = 0;
    const rotatingFetch = async () => {
      fetches++;
      return fetchJwks();
    };
    const good = await signJwt(goodPayload());
    const rotated = await signJwt(goodPayload(), { kid: "rotated" });

    expect(await verify(good, rotatingFetch)).toBe(true);
    // Cached — same kid verifies without another fetch.
    expect(await verify(good, rotatingFetch)).toBe(true);
    expect(fetches).toBe(1);

    // An unknown kid within the cooldown must NOT refetch — otherwise a flood
    // of random-kid tokens amplifies into one origin→certs fetch each. It
    // fails closed off the cached keys instead.
    expect(await verify(rotated, rotatingFetch)).toBe(false);
    expect(fetches).toBe(1);

    // Once the cooldown elapses, a genuinely rotated kid triggers exactly one
    // refetch — key rotation is still observed, just rate-limited.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 61_000));
    expect(await verify(rotated, rotatingFetch)).toBe(false);
    expect(fetches).toBe(2);
  });
});
