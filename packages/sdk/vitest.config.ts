import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The package is a scaffold — the client and the wire schemas land in
    // TASK-004/006, the commands in TASK-005. Remove this the moment there is
    // something here to test; an empty suite that reports green is only
    // honest while the package is empty on purpose.
    passWithNoTests: true,
  },
});
