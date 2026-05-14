import { readdir, stat, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * One row in the discovery view. Tells the UI:
 *   - what's there (path, name)
 *   - what kind of project it is (stack hint)
 *   - whether we already have it imported (so we don't re-add)
 */
export interface DiscoveredProject {
  name: string;
  path: string;
  stack: string[];
  isGitRepo: boolean;
  alreadyImported: boolean;
}

const HIDDEN_PREFIXES = [".", "_"];
// Things that look like project directories but aren't useful to manage as
// DryDock projects. Mostly tooling.
const SKIP_NAMES = new Set([
  "node_modules",
  ".git",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  "target",
  ".claude",
  ".cloudflared",
  ".drydock",
]);

interface DetectFile {
  file: string;
  label: string;
}

/**
 * Tech-stack fingerprints. We check the presence (and sometimes contents)
 * of a small set of marker files. Cheap to do — one stat per file.
 */
const STACK_MARKERS: DetectFile[] = [
  { file: "package.json", label: "node" },
  { file: "next.config.js", label: "next" },
  { file: "next.config.ts", label: "next" },
  { file: "next.config.mjs", label: "next" },
  { file: "vite.config.ts", label: "vite" },
  { file: "vite.config.js", label: "vite" },
  { file: "pnpm-lock.yaml", label: "pnpm" },
  { file: "requirements.txt", label: "python" },
  { file: "pyproject.toml", label: "python" },
  { file: "Cargo.toml", label: "rust" },
  { file: "go.mod", label: "go" },
  { file: "Gemfile", label: "ruby" },
  { file: "composer.json", label: "php" },
];

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Look at marker files in a directory and infer a small set of stack
 * labels. Order matters slightly: package.json + next.config.* → ["node",
 * "next"]; consumers usually want the more specific label first when
 * rendering a single chip.
 */
async function detectStack(dir: string): Promise<string[]> {
  const labels = new Set<string>();
  for (const m of STACK_MARKERS) {
    if (await exists(join(dir, m.file))) labels.add(m.label);
  }
  // Sharpen "node" → "next" when both apply, and prefer the framework label.
  if (labels.has("next") && labels.has("node")) labels.delete("node");
  if (labels.has("vite") && labels.has("node")) labels.delete("node");
  return Array.from(labels);
}

async function isGitRepo(dir: string): Promise<boolean> {
  return exists(join(dir, ".git"));
}

export interface ScanOptions {
  /** Absolute path to the directory whose children we should enumerate. */
  root: string;
  /** Paths already registered as DryDock projects (to mark `alreadyImported`). */
  knownPaths: Set<string>;
  /** Max number of children to return — protects the UI from huge dirs. */
  limit?: number;
}

/**
 * Scan one level deep under `root`. Returns DiscoveredProject rows
 * sorted by name. Hidden dirs and known-tooling dirs are filtered out.
 *
 * One level deep is the right depth for the user's /Projects/ layout —
 * each child is a project. Going deeper risks pulling in node_modules
 * directories that happen to look like git repos, and the performance
 * cost on a typical SSD is ~50ms per level so depth=1 keeps the API fast.
 */
export async function scanProjectsRoot(
  options: ScanOptions,
): Promise<DiscoveredProject[]> {
  const { root, knownPaths, limit = 100 } = options;

  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    throw new Error(
      `Could not read root directory ${root}: ${(err as Error).message}`,
    );
  }

  const dirs = entries.filter((e) => {
    if (!e.isDirectory()) return false;
    if (SKIP_NAMES.has(e.name)) return false;
    if (HIDDEN_PREFIXES.some((p) => e.name.startsWith(p))) return false;
    return true;
  });

  const results = await Promise.all(
    dirs.slice(0, limit).map(async (entry) => {
      const path = join(root, entry.name);
      const [stack, git] = await Promise.all([detectStack(path), isGitRepo(path)]);
      const row: DiscoveredProject = {
        name: entry.name,
        path,
        stack,
        isGitRepo: git,
        alreadyImported: knownPaths.has(path),
      };
      return row;
    }),
  );

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

const DOC_FILES = [
  "issues.md",
  "backlog.md",
  "drydock-backlog.md",
  "CLAUDE.md",
  "AGENTS.md",
  "design.md",
  "README.md",
] as const;

export type DocName = (typeof DOC_FILES)[number];

export interface ProjectDoc {
  name: DocName;
  exists: boolean;
  size: number;
  /** Set when `exists` is true. Bounded to avoid sending mega-files. */
  content?: string;
  truncated?: boolean;
}

const DOC_MAX_BYTES = 256 * 1024; // 256 KB ceiling per file

/**
 * Read the small set of "what's happening in this project" docs for the
 * UI. Files that don't exist come back with `exists: false` and no
 * content; files over 256 KB come back with `truncated: true` and the
 * first 256 KB so the UI can show the head and a "this is long" hint.
 */
export async function readProjectDocs(
  projectPath: string,
): Promise<ProjectDoc[]> {
  return Promise.all(
    DOC_FILES.map(async (name): Promise<ProjectDoc> => {
      const path = join(projectPath, name);
      try {
        const s = await stat(path);
        if (!s.isFile()) {
          return { name, exists: false, size: 0 };
        }
        if (s.size <= DOC_MAX_BYTES) {
          const content = await readFile(path, "utf8");
          return { name, exists: true, size: s.size, content };
        }
        // Read just the head — enough to be useful, not enough to OOM.
        const handle = await import("node:fs/promises").then((m) =>
          m.open(path, "r"),
        );
        try {
          const buf = Buffer.alloc(DOC_MAX_BYTES);
          await handle.read(buf, 0, DOC_MAX_BYTES, 0);
          return {
            name,
            exists: true,
            size: s.size,
            content: buf.toString("utf8"),
            truncated: true,
          };
        } finally {
          await handle.close();
        }
      } catch {
        return { name, exists: false, size: 0 };
      }
    }),
  );
}
