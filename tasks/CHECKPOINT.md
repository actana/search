# Checkpoint — 2026-09-15 (end of day 2)

The authoritative checkpoint is on the Studio side:
`wt-search-extraction/tasks/search-extraction/CHECKPOINT.md`.

Train `beta/0.1.0` at this commit's parent (`405d7bd`) carries TASK-002/003, 006,
**004, 005 and 004b**, each squash-merged after Fable review; 1106 tests green,
the frozen Studio fixture suite replays 15/15 over REST. Feature branches
`feat/rest-api-and-contracts`, `feat/endpoint-sources-worker-cli`,
`feat/query-contract-additions` are merged and pushed (delete when convenient).

Owed on this side: a Fable verification of `ac5ef0d` (the pre-merge round on 005:
lock-serialised replace-before-insert inside the engine's chunk transaction,
`usage_count` decrement — gates green, unreviewed), and two wire additions
(`GET /v1/kbs/:kbId/chunks/:chunkId/keywords` with link `source`; `documentId` on
`ChunkSchema`). Then TASK-012 pairs a real Studio to a real instance.
