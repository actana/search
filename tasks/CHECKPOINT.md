# Checkpoint — 2026-09-15

See the full checkpoint in Studio: `wt-search-extraction/tasks/search-extraction/CHECKPOINT.md`.

Search-repo state at this checkpoint:

- `beta/0.1.0` (the open train): TASK-002/003 (`ee3232d`) and TASK-006 (`65a8d9c`), both reviewed.
- `feat/rest-api-and-contracts`: TASK-004 done (4 commits, 816 tests, 36 routes, fixture 15/15 over REST). **Unreviewed, unmerged.**
- `feat/endpoint-sources-worker-cli`: TASK-005 done (4 commits, 852 tests; endpoint sources, worker, CLI, migration 0002, ADR 0010). **Unreviewed, unmerged.** Lives in worktree `../actana-search-wt-b`.
- Next: review both, rebase 005 onto 004 (reconcile `events.ts`, `queue/index.ts`, `api/routes/endpoints.ts` inline registry → `models/endpoint-registry.ts`, drop the stopgap `POST /admin/endpoints`, additive `index.ts`/`config.ts` hunks, migration journal order), squash-merge into the train, push.
- `tasks/todo/TASK-005-*.md` is still in `todo/` on the train because the branch that moves it has not merged.
