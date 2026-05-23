/**
 * Vitest configuration.
 *
 * Mirrors the `@/*` path alias from tsconfig.json so test files can use
 * the same imports as the rest of the codebase. Node environment is the
 * default (no DOM); a future component-test config will add jsdom in a
 * separate file or via `// @vitest-environment` headers.
 */
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    // Node env - no DOM. Document upload actions don't need one.
    environment: "node",
    // Pick up both co-located tests and __tests__ folders. `scripts/`
    // is included for the Day 21 self-healing seed tests, which exercise
    // `scripts/seed.ts` directly.
    include: [
      "lib/**/*.test.ts",
      "lib/**/__tests__/**/*.test.ts",
      "scripts/**/__tests__/**/*.test.ts",
    ],
    // Same TLS / system-CA workaround as the smoke test, in case any
    // test code path ends up making a real R2 call. Forks pool also gives
    // each test file its own worker process, which keeps the in-memory
    // SQLite DB (set up in vitest.setup.ts) isolated per file.
    pool: "forks",
    // Apply Drizzle migrations to the per-worker in-memory DB before any
    // test runs. Without this, tests would hit "no such table" errors.
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
