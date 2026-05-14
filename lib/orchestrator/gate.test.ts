import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { runQualityGate } from "./gate";

describe("runQualityGate", () => {
  it("reports passed when the command exits 0", async () => {
    const result = await runQualityGate("echo ok", tmpdir());
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("ok");
  });

  it("reports failed when the command exits non-zero", async () => {
    const result = await runQualityGate("exit 3", tmpdir());
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(3);
  });

  it("captures stderr in the combined output", async () => {
    const result = await runQualityGate("echo problem 1>&2; exit 1", tmpdir());
    expect(result.passed).toBe(false);
    expect(result.output).toContain("problem");
  });

  it("kills a hung command at the timeout", async () => {
    const result = await runQualityGate("sleep 30", tmpdir(), 100);
    expect(result.passed).toBe(false);
    // Killed by signal → -1 sentinel.
    expect(result.exitCode).toBe(-1);
  });
});
