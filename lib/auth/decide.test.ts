import { describe, expect, it } from "vitest";
import {
  decideRequest,
  isLocalRequest,
  resolveAuthConfig,
  tokensMatch,
  type RequestFacts,
} from "./decide";

function facts(overrides: Partial<RequestFacts> = {}): RequestFacts {
  return {
    host: "drydock.example.com",
    hasCloudflareHeaders: true,
    bearerToken: null,
    cookieToken: null,
    accessJwt: null,
    isApiRequest: false,
    ...overrides,
  };
}

const neverVerify = async (): Promise<boolean> => false;
const alwaysVerify = async (): Promise<boolean> => true;

describe("resolveAuthConfig", () => {
  it("prefers cf-access when both team domain and aud are set", () => {
    expect(
      resolveAuthConfig({
        CF_ACCESS_TEAM_DOMAIN: "team",
        CF_ACCESS_AUD: "aud123",
        DRYDOCK_AUTH_TOKEN: "tok",
      }).mode,
    ).toBe("cf-access");
  });

  it("falls back to token mode, then closed", () => {
    expect(resolveAuthConfig({ DRYDOCK_AUTH_TOKEN: "tok" }).mode).toBe("token");
    expect(resolveAuthConfig({}).mode).toBe("closed");
    // Half-configured Access does NOT count — fail closed, not half-open.
    expect(resolveAuthConfig({ CF_ACCESS_TEAM_DOMAIN: "team" }).mode).toBe(
      "closed",
    );
    expect(resolveAuthConfig({ DRYDOCK_AUTH_TOKEN: "   " }).mode).toBe(
      "closed",
    );
  });
});

describe("isLocalRequest", () => {
  it("accepts localhost variants without Cloudflare headers", () => {
    for (const host of ["localhost:3000", "localhost", "127.0.0.1:3000", "[::1]:3000"]) {
      expect(
        isLocalRequest(facts({ host, hasCloudflareHeaders: false })),
      ).toBe(true);
    }
  });

  it("rejects localhost Host when the request transited Cloudflare", () => {
    // An attacker sending `Host: localhost` through the tunnel still gets
    // cf-ray stamped by the edge — the spoofable header alone never wins.
    expect(
      isLocalRequest(facts({ host: "localhost:3000", hasCloudflareHeaders: true })),
    ).toBe(false);
  });

  it("rejects non-local hosts and missing Host", () => {
    expect(isLocalRequest(facts({ hasCloudflareHeaders: false }))).toBe(false);
    expect(
      isLocalRequest(facts({ host: null, hasCloudflareHeaders: false })),
    ).toBe(false);
    // Substring tricks must not pass.
    expect(
      isLocalRequest(
        facts({ host: "localhost.evil.com", hasCloudflareHeaders: false }),
      ),
    ).toBe(false);
  });
});

describe("tokensMatch", () => {
  it("matches equal tokens and rejects everything else", async () => {
    expect(await tokensMatch("secret", "secret")).toBe(true);
    expect(await tokensMatch("secret", "secret2")).toBe(false);
    expect(await tokensMatch("", "secret")).toBe(false);
  });
});

describe("decideRequest", () => {
  it("local requests bypass every mode", async () => {
    const local = facts({ host: "localhost:3000", hasCloudflareHeaders: false });
    for (const config of [
      resolveAuthConfig({}),
      resolveAuthConfig({ DRYDOCK_AUTH_TOKEN: "t" }),
      resolveAuthConfig({ CF_ACCESS_TEAM_DOMAIN: "t", CF_ACCESS_AUD: "a" }),
    ]) {
      expect(await decideRequest(config, local, neverVerify)).toEqual({
        action: "allow",
      });
    }
  });

  it("closed mode denies all non-local requests", async () => {
    const decision = await decideRequest(
      resolveAuthConfig({}),
      facts(),
      alwaysVerify,
    );
    expect(decision.action).toBe("closed");
  });

  it("token mode: bearer or cookie unlocks, otherwise 401 for API and login redirect for pages", async () => {
    const config = resolveAuthConfig({ DRYDOCK_AUTH_TOKEN: "s3cret" });
    expect(
      (await decideRequest(config, facts({ bearerToken: "s3cret" }), neverVerify))
        .action,
    ).toBe("allow");
    expect(
      (await decideRequest(config, facts({ cookieToken: "s3cret" }), neverVerify))
        .action,
    ).toBe("allow");
    expect(
      (
        await decideRequest(
          config,
          facts({ bearerToken: "wrong", isApiRequest: true }),
          neverVerify,
        )
      ).action,
    ).toBe("unauthorized");
    expect(
      (await decideRequest(config, facts(), neverVerify)).action,
    ).toBe("redirect-login");
  });

  it("cf-access mode: only a verified assertion passes; pages get 401 too", async () => {
    const config = resolveAuthConfig({
      CF_ACCESS_TEAM_DOMAIN: "team",
      CF_ACCESS_AUD: "aud",
    });
    expect(
      (
        await decideRequest(config, facts({ accessJwt: "jwt" }), alwaysVerify)
      ).action,
    ).toBe("allow");
    expect(
      (
        await decideRequest(config, facts({ accessJwt: "jwt" }), neverVerify)
      ).action,
    ).toBe("unauthorized");
    expect((await decideRequest(config, facts(), alwaysVerify)).action).toBe(
      "unauthorized",
    );
  });
});
