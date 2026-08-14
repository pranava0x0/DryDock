import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Vitest needs the same @/ alias the TS compiler uses, otherwise tests can't
// import lib/* modules the way the app does.
const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": rootDir,
    },
  },
  test: {
    // Tests touch the filesystem (SQLite files, temp dirs) and shell out to
    // child processes. Sequential execution keeps them simple and the suite
    // is small enough that wall-clock isn't a concern yet.
    fileParallelism: false,
    // `components/` is included for the non-React logic that lives beside
    // the hooks — cache invalidation, summary formatting. Rendering tests
    // would need a DOM environment; these deliberately don't.
    include: ["lib/**/*.test.ts", "components/**/*.test.ts"],
    environment: "node",
  },
});
