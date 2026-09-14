import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    // Integration suites talk to a real Postgres and are gated on
    // `SEARCH_TEST_DATABASE_URL` from inside the file (`describe.skipIf`), so
    // they are collected here and skip themselves when the variable is absent.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Serial, by file.
    //
    // Several suites here talk to the same Postgres, and running them at once
    // produces failures that point anywhere but at the cause. The migration
    // suite additionally works in a database of its own — see its header — so
    // that the one suite whose job is to drop and rebuild the schema cannot do
    // it underneath another.
    //
    // The whole package runs in about twenty seconds either way, so there is
    // nothing to buy back by parallelising it.
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
  },
  resolve: {
    alias: {
      // Same mapping as tsconfig's `paths` — vitest needs telling where the
      // sibling package lives.
      "@actana/search-shared": path.resolve(import.meta.dirname, "../shared/src"),
    },
  },
});
