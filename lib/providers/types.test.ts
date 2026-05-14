import { describe, it, expect } from "vitest";
import { isProviderName, PROVIDER_NAMES } from "./types";
import { getProvider } from "./index";

describe("provider type guards", () => {
  it("isProviderName accepts known names", () => {
    expect(isProviderName("claude")).toBe(true);
    expect(isProviderName("gemini")).toBe(true);
  });

  it("isProviderName rejects everything else", () => {
    expect(isProviderName("openai")).toBe(false);
    expect(isProviderName("")).toBe(false);
    expect(isProviderName(null)).toBe(false);
    expect(isProviderName(42)).toBe(false);
  });

  it("PROVIDER_NAMES enumerates every supported provider", () => {
    expect(PROVIDER_NAMES).toEqual(["claude", "gemini"]);
  });
});

describe("provider registry", () => {
  it("returns the registered providers by name", () => {
    expect(getProvider("claude").name).toBe("claude");
    expect(getProvider("gemini").name).toBe("gemini");
  });

  it("returns a no-op stub when DRYDOCK_PROVIDER_STUB=1 (UAT escape hatch)", async () => {
    const original = process.env.DRYDOCK_PROVIDER_STUB;
    process.env.DRYDOCK_PROVIDER_STUB = "1";
    try {
      const provider = getProvider("claude");
      const events = [];
      for await (const e of provider.run("test prompt", { cwd: "/tmp" })) {
        events.push(e);
      }
      // 3 events: stdout note + usage event with zeros + exit 0.
      expect(events).toHaveLength(3);
      expect(events[0].type).toBe("stdout");
      expect(events[1].type).toBe("usage");
      expect(events[2].type).toBe("exit");
      if (events[2].type === "exit") {
        expect(events[2].code).toBe(0);
      }
    } finally {
      if (original === undefined) delete process.env.DRYDOCK_PROVIDER_STUB;
      else process.env.DRYDOCK_PROVIDER_STUB = original;
    }
  });
});
