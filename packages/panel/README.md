# `@actana/search-panel` — placeholder

The standalone management UI for a Search instance: knowledge bases, documents
and their ingest state, keyword and cluster curation, the endpoint registry,
and the paired clients. It is the analogue of Control's Panel, and like the
Panel it is a consumer of the SDK — it never reaches past `@actana/search` into
the core's tables.

Nothing is here yet. The Panel is **TASK-016**, deliberately last: the CLI
(TASK-005) proves the same routes first, and a UI written before the wire is
settled is a UI rewritten after it.

Until then, a Search instance is driven with `actana-search` (`packages/cli`).
