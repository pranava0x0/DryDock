import { spawn } from "node:child_process";

export interface GateResult {
  passed: boolean;
  exitCode: number;
  output: string;
}

/**
 * Run a project's quality gate (e.g. `npm test`) inside the given working
 * directory and capture the combined stdout/stderr.
 *
 * We use a shell so users can write natural commands like `npm test &&
 * npm run typecheck` instead of having to think about argv tokenization.
 * The combined output is bounded by the OS pipe buffer but we don't try
 * to truncate it here — pathological test suites will be capped at
 * persistence time.
 */
export function runQualityGate(
  command: string,
  cwd: string,
  timeoutMs = 5 * 60 * 1000,
): Promise<GateResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let output = "";
    const append = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    // Kill the test process if it overruns. Tests legitimately take a
    // while but a five-minute cap keeps a stuck gate from blocking
    // unrelated work forever.
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    }, timeoutMs);
    timer.unref();

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        passed: false,
        exitCode: -1,
        output: `${output}\n[drydock] gate spawn failed: ${err.message}`,
      });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      const exitCode = code ?? (signal ? -1 : 0);
      resolve({
        passed: exitCode === 0,
        exitCode,
        output,
      });
    });
  });
}
