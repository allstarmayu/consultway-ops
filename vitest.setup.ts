/**
 * Vitest setup — runs once per worker process before any tests in that
 * worker execute.
 *
 * Two responsibilities:
 *
 *   1. **Defensive `NODE_ENV=test`.** Vitest sets this by default, but
 *      `lib/env.ts` reads `process.env` at module load and any import
 *      that crosses through `env` before vitest's own setup would lock
 *      in the wrong value. Setting it here makes the order-of-imports
 *      bug impossible.
 *
 *   2. **Apply Drizzle migrations to the in-memory DB.** `lib/db/index.ts`
 *      branches on `NODE_ENV === "test"` to use `":memory:"` instead of
 *      the file-backed dev SQLite. An in-memory DB starts empty — without
 *      this step every test query would fail with "no such table".
 *      Migrating once per worker keeps the schema in sync with the dev
 *      DB without per-test setup cost.
 *
 * Vitest's default `pool: "forks"` (set in `vitest.config.ts`) gives each
 * test file its own worker process. That means each file gets a fresh
 * `:memory:` DB, fully isolated from sibling files — no cross-file
 * fixture leaks. Within a single file, tests share the worker's DB and
 * are responsible for their own `beforeEach`/`afterEach` cleanup (the
 * existing test files already do this pattern).
 *
 * @module vitest.setup
 */
// `process.env.NODE_ENV` is typed as a read-only literal union in
// `@types/node`; the cast widens it just for this assignment. Vitest
// already sets NODE_ENV=test by default but we set it defensively in
// case some import chain reads `lib/env.ts` before vitest's own setup.
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { db } from "@/lib/db";

migrate(db, { migrationsFolder: "./drizzle" });
