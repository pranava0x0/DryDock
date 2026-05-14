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
    include: ["lib/**/*.test.ts"],
    environment: "node",
  },
});
