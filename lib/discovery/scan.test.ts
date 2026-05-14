import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanProjectsRoot, readProjectDocs } from "./scan";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "drydock-scan-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeDir(name: string, files: Record<string, string> = {}): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(path, filename), content);
  }
  return path;
}

describe("scanProjectsRoot", () => {
  it("lists immediate subdirectories sorted by name", async () => {
    makeDir("charlie");
    makeDir("alpha");
    makeDir("bravo");
    const result = await scanProjectsRoot({
      root,
      knownPaths: new Set(),
    });
    expect(result.map((r) => r.name)).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("skips hidden and tooling dirs", async () => {
    makeDir(".cache");
    makeDir("_internal");
    makeDir("node_modules");
    makeDir(".next");
    makeDir(".claude");
    makeDir("real-project");
    const result = await scanProjectsRoot({
      root,
      knownPaths: new Set(),
    });
    expect(result.map((r) => r.name)).toEqual(["real-project"]);
  });

  it("detects Next.js + git", async () => {
    const path = makeDir("my-next-app", {
      "package.json": "{}",
      "next.config.ts": "export default {};",
    });
    mkdirSync(join(path, ".git"));
    const result = await scanProjectsRoot({
      root,
      knownPaths: new Set(),
    });
    expect(result).toHaveLength(1);
    // node label is sharpened away when next is present (more specific wins).
    expect(result[0].stack).toContain("next");
    expect(result[0].stack).not.toContain("node");
    expect(result[0].isGitRepo).toBe(true);
  });

  it("detects Python projects (requirements.txt and pyproject.toml)", async () => {
    makeDir("flask-app", { "requirements.txt": "flask" });
    makeDir("modern-py", { "pyproject.toml": "[project]\nname='x'" });
    const result = await scanProjectsRoot({
      root,
      knownPaths: new Set(),
    });
    expect(result.every((r) => r.stack.includes("python"))).toBe(true);
  });

  it("marks alreadyImported when path is in knownPaths", async () => {
    const a = makeDir("a");
    const b = makeDir("b");
    const result = await scanProjectsRoot({
      root,
      knownPaths: new Set([a]),
    });
    const rowA = result.find((r) => r.path === a);
    const rowB = result.find((r) => r.path === b);
    expect(rowA?.alreadyImported).toBe(true);
    expect(rowB?.alreadyImported).toBe(false);
  });

  it("respects the limit option", async () => {
    for (let i = 0; i < 5; i++) makeDir(`p${i}`);
    const result = await scanProjectsRoot({
      root,
      knownPaths: new Set(),
      limit: 2,
    });
    expect(result).toHaveLength(2);
  });

  it("throws a friendly error when the root doesn't exist", async () => {
    await expect(
      scanProjectsRoot({
        root: "/tmp/drydock-scan-does-not-exist-xyz",
        knownPaths: new Set(),
      }),
    ).rejects.toThrow(/Could not read root directory/);
  });
});

describe("readProjectDocs", () => {
  it("returns each canonical doc with exists + content when present", async () => {
    const path = makeDir("proj", {
      "issues.md": "# Issues\n",
      "CLAUDE.md": "# Project guide\n",
    });
    const docs = await readProjectDocs(path);
    const issues = docs.find((d) => d.name === "issues.md");
    const claude = docs.find((d) => d.name === "CLAUDE.md");
    const backlog = docs.find((d) => d.name === "backlog.md");
    expect(issues?.exists).toBe(true);
    expect(issues?.content).toBe("# Issues\n");
    expect(claude?.exists).toBe(true);
    // Missing files come back as { exists: false, size: 0 } — the UI uses
    // this to filter rather than guess from a 404.
    expect(backlog?.exists).toBe(false);
    expect(backlog?.size).toBe(0);
  });

  it("truncates files over the 256 KB ceiling", async () => {
    const path = makeDir("proj");
    // Build a > 256 KB README. Each chunk is ~64 B.
    const big = "x".repeat(64) + "\n";
    const big300kb = big.repeat(5000); // ~325 KB
    writeFileSync(join(path, "README.md"), big300kb);
    const docs = await readProjectDocs(path);
    const readme = docs.find((d) => d.name === "README.md");
    expect(readme?.exists).toBe(true);
    expect(readme?.truncated).toBe(true);
    expect(readme?.content?.length ?? 0).toBeLessThanOrEqual(256 * 1024);
    expect(readme?.size).toBeGreaterThan(256 * 1024);
  });
});
