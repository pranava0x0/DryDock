import { describe, it, expect, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { rejectRemoteDispatch } from "./local-only";

afterEach(() => {
  delete process.env.DRYDOCK_LOCAL_DISPATCH_ONLY;
});

function req(url: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(url, { method: "POST", headers });
}

describe("rejectRemoteDispatch", () => {
  it("is a no-op when the flag is unset", () => {
    const remote = req("https://drydock.example.com/api/sessions", {
      host: "drydock.example.com",
    });
    expect(rejectRemoteDispatch(remote)).toBeNull();
  });

  it("allows localhost when enabled", () => {
    process.env.DRYDOCK_LOCAL_DISPATCH_ONLY = "1";
    const local = req("http://localhost:3000/api/sessions", {
      host: "localhost:3000",
    });
    expect(rejectRemoteDispatch(local)).toBeNull();
  });

  it("403s a non-local host when enabled", async () => {
    process.env.DRYDOCK_LOCAL_DISPATCH_ONLY = "1";
    const res = rejectRemoteDispatch(
      req("https://drydock.example.com/api/sessions", {
        host: "drydock.example.com",
      }),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    const body = await res!.json();
    expect(body.error).toMatch(/DRYDOCK_LOCAL_DISPATCH_ONLY/);
  });

  it("403s tunnel traffic even when it claims a localhost host", () => {
    process.env.DRYDOCK_LOCAL_DISPATCH_ONLY = "1";
    const forged = req("http://localhost:3000/api/sessions", {
      host: "localhost:3000",
      "cf-ray": "8f00ba11",
    });
    const res = rejectRemoteDispatch(forged);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });
});
