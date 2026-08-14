import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Covers the persistence half of the client cache — the part that
 * survives a reload and therefore the part whose bugs outlive the process
 * that caused them.
 *
 * A stale entry left in `sessionStorage` after a write is worse than a
 * stale entry in memory: memory dies with the tab, but a survivor here
 * comes back on the next load, so a backlog row the user deleted can
 * reappear after a refresh. That is the regression this file guards.
 *
 * Rendering is deliberately out of scope (the suite runs in `node`, with
 * no DOM); `invalidateCachedResource` is plain module-level logic and
 * needs only a `window.sessionStorage` stand-in.
 */

const STORAGE_PREFIX = "drydock:cache:";

class FakeStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  get length(): number {
    return this.map.size;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  /** `Object.keys(sessionStorage)` is how the module enumerates. */
  toObject(): Record<string, string> {
    return Object.fromEntries(this.map);
  }
}

let storage: FakeStorage;

beforeEach(() => {
  storage = new FakeStorage();
  // The module guards on `typeof window === "undefined"`, so a stand-in
  // is enough — no jsdom needed.
  (globalThis as unknown as { window: unknown }).window = {
    sessionStorage: new Proxy(storage, {
      // `Object.keys(sessionStorage)` must see the stored keys, which a
      // class instance with a private Map would otherwise hide.
      ownKeys: () => Object.keys(storage.toObject()),
      getOwnPropertyDescriptor: () => ({
        enumerable: true,
        configurable: true,
      }),
      get: (target, prop) => {
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

/**
 * A static import is safe here: the module reads `window` only inside the
 * functions, never at evaluation time, so importing before `beforeEach`
 * installs the stand-in is fine. (A `?t=` cache-buster query was tried
 * first and broke the TypeScript transform — the loader can't infer `.ts`
 * through a query string.)
 */
async function loadModule() {
  return import("./useCachedResource");
}

describe("invalidateCachedResource", () => {
  it("clears every persisted entry under the prefix", async () => {
    const { invalidateCachedResource } = await loadModule();
    storage.setItem(`${STORAGE_PREFIX}/api/backlog?status=idea`, "a");
    storage.setItem(`${STORAGE_PREFIX}/api/backlog?status=done`, "b");

    invalidateCachedResource("/api/backlog");

    expect(storage.getItem(`${STORAGE_PREFIX}/api/backlog?status=idea`)).toBeNull();
    expect(storage.getItem(`${STORAGE_PREFIX}/api/backlog?status=done`)).toBeNull();
  });

  it("clears the filter you are NOT looking at", async () => {
    // The whole point: marking an item done changes what `?status=idea`
    // returns as well, and that copy is the one nobody sees go stale.
    const { invalidateCachedResource } = await loadModule();
    storage.setItem(`${STORAGE_PREFIX}/api/backlog?status=idea`, "stale");

    invalidateCachedResource("/api/backlog");

    expect(storage.getItem(`${STORAGE_PREFIX}/api/backlog?status=idea`)).toBeNull();
  });

  it("leaves unrelated resources alone", async () => {
    const { invalidateCachedResource } = await loadModule();
    storage.setItem(`${STORAGE_PREFIX}/api/projects`, "keep");
    storage.setItem(`${STORAGE_PREFIX}/api/overview`, "keep");
    storage.setItem(`${STORAGE_PREFIX}/api/backlog?status=idea`, "drop");

    invalidateCachedResource("/api/backlog");

    expect(storage.getItem(`${STORAGE_PREFIX}/api/projects`)).toBe("keep");
    expect(storage.getItem(`${STORAGE_PREFIX}/api/overview`)).toBe("keep");
    expect(storage.getItem(`${STORAGE_PREFIX}/api/backlog?status=idea`)).toBeNull();
  });

  it("does not touch keys outside the cache namespace", async () => {
    // sessionStorage is shared with the rest of the app — Analytics keeps
    // its selected tab there.
    const { invalidateCachedResource } = await loadModule();
    storage.setItem("drydock:analytics-tab", "flow");

    invalidateCachedResource("/api");

    expect(storage.getItem("drydock:analytics-tab")).toBe("flow");
  });

  it("is a no-op when nothing matches", async () => {
    const { invalidateCachedResource } = await loadModule();
    storage.setItem(`${STORAGE_PREFIX}/api/projects`, "keep");

    expect(() => invalidateCachedResource("/api/nothing")).not.toThrow();
    expect(storage.getItem(`${STORAGE_PREFIX}/api/projects`)).toBe("keep");
  });

  it("survives a storage that throws (private mode, quota)", async () => {
    const { invalidateCachedResource } = await loadModule();
    (globalThis as unknown as { window: { sessionStorage: unknown } }).window = {
      get sessionStorage(): never {
        throw new Error("SecurityError");
      },
    };
    // Must degrade rather than take the page down mid-write.
    expect(() => invalidateCachedResource("/api/backlog")).not.toThrow();
  });
});
