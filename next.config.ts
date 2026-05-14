import type { NextConfig } from "next";

// better-sqlite3 is a native Node addon. It must not be bundled into the
// server build by Next.js — leave it as an external `require()` at runtime.
const config: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
};

export default config;
