#!/usr/bin/env node
// The `bin` shim.
//
// A `.mjs` rather than pointing `bin` straight at `src/index.ts`, because a
// package manager writes a shim that execs this path with the user's `node` and
// nothing else — no flags, no loader — and a `.ts` entry then depends on which
// Node that is. This file is plain JavaScript on every Node, and the `import`
// below is where type stripping happens: Node 24 runs the TypeScript directly,
// which is the same thing the service does (`deploy/Dockerfile`).
//
// `index.ts` only self-runs when it is `process.argv[1]`, which it is not when
// this shim was what was executed — so `main` is called here, exactly once.

const { main } = await import("../src/index.ts");
await main(process.argv.slice(2));
