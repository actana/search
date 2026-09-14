# Search owns its data — the `search` schema

Search runs its own migrations against a Postgres schema it owns, named
`search`. Every table the engine reads or writes lives there: the knowledge
bases, the documents, the shared `embedding` table, the per-KB vector
partitions, the clusters, the keyword vocabulary and its link tables, the embed
ledger, and Search's own `paired_client`, `pairing_code` and `model_endpoint`.
Studio's `public` schema never references any of them, and Search references
nothing outside `search`.

When the two share one Postgres server — which they will, at first — this is
"same database, its own tables" without a second server to run, and moving
Search to a database of its own later is a connection-string change rather than
a migration. The lifted tables keep Studio's columns exactly so that the phase-4
data move is as small as it can be.

**It is not, however, one statement.** `ALTER TABLE … SET SCHEMA` moves a table
and everything attached to it, including foreign keys pointing at tables that
are staying behind — `public.user`, `public.workspace`,
`public.workspace_model_endpoints`, `public.knowledge_connector` — which have to
be dropped or re-pointed as part of the move. The `knowledge_base` indexes carry
`user` and `workspace` in their names and are renamed with the columns.
`paired_client_id` is NOT NULL here and Studio's `workspace_id` is not, so rows
with no workspace need an owner before they can move at all. And
`search.model_endpoint` is not column-compatible with
`workspace_model_endpoints`: it is a mirror the client pushes (ADR 0004), not a
table that moves. The statement-by-statement list is
[`docs/migration-from-studio.md`](../migration-from-studio.md); TASK-013
implements and rehearses it.

Three columns change name, because three concepts do not cross the boundary.
`workspace_id` becomes `paired_client_id`: Search does not know what a workspace
is, only which client certificate owns a row. `user_id` becomes `owner_id` and
becomes plain text with no foreign key: Search has no user table and will not
grow one. The endpoint columns point at `search.model_endpoint` instead of
Studio's `workspace_model_endpoints`.

## Considered Options

- **A second database server (rejected for now).** The cleanest isolation and
  the most operational weight — another server to run, back up and monitor
  before the split has proven anything. The schema boundary gets the
  ownership property today and leaves the server split as a connection string.
- **Share Studio's `public` schema and prefix the tables (rejected).** No
  boundary at all: two migration tools writing into one namespace, with
  `drizzle-kit generate` on either side free to emit a `DROP` for the other's
  tables.
- **Let Studio keep reading the tables directly during the transition
  (rejected).** It would make the cutover invisible and painless, and it would
  make the boundary a fiction — every shortcut taken during the transition
  becomes permanent, because nothing ever forces it closed. ADR 0003's rule
  that the SDK is the only way in exists for the same reason.

## Consequences

- Search's Drizzle schema is `pgSchema('search')` and nothing else. The
  migrations create the extension (`CREATE EXTENSION IF NOT EXISTS vector`) and
  are applied at boot as well as by hand.
- **Per-KB partitions are not in the schema file.** `kb_embedding_<sha>` tables
  carry a vector column sized to their KB's model, so they are created at
  runtime by the DDL module. Listing them in the Drizzle schema would make
  `drizzle-kit generate` emit `DROP TABLE` for live data.
- `agent_knowledge_base` stays in Studio. An agent is a Studio concept; its
  `knowledge_base_id` becomes a plain remote id with no constraint behind it.
  The same is true of `knowledge_connector` and its sync log.
- Search should be given its own database role, scoped to its own schema. When
  it shares a server with Studio it must not be able to read Studio's tables,
  and the schema boundary is what makes that expressible.
