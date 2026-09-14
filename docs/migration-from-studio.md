# Moving the data out of Studio

What TASK-013 has to do, written down while the schema is fresh rather than
rediscovered later. This is the phase-4 migration: Studio's knowledge-base rows
become Search's, in place, in the same Postgres.

It is **not** `ALTER TABLE … SET SCHEMA` and nothing else, and an earlier
version of `packages/search/src/db/schema.ts` said it was. `SET SCHEMA` moves a
table with everything attached to it — its indexes, its constraints, and its
foreign keys — and four of those foreign keys point at tables that are staying
in `public`. A migration that ran only the `SET SCHEMA` statements would leave
Search's schema tied to Studio's user table, and the split would exist on paper
only.

The tables that move are the ten lifted ones: `knowledge_base`, `document`,
`embedding`, `document_embed_batch`, `knowledge_base_tag_definitions`,
`kb_cluster`, `kb_keyword`, `embedding_keyword`, `document_keyword`, and the
per-KB `kb_embedding_<sha>` partitions.

## 1. Foreign keys that have to go or be re-pointed

| Table | Constraint on | Points at | What happens |
|---|---|---|---|
| `knowledge_base` | `user_id` | `public.user(id)` | **Drop.** Becomes `owner_id`, plain text. Search has no user table. |
| `knowledge_base` | `workspace_id` | `public.workspace(id)` | **Drop.** Becomes `paired_client_id` → `search.paired_client(id)`, added after the paired-client rows exist. |
| `knowledge_base` | `embedding_endpoint_id` | `public.workspace_model_endpoints(id)` | **Drop, re-point** at `search.model_endpoint(id)` — see §4. |
| `knowledge_base` | `inference_endpoint_id` | `public.workspace_model_endpoints(id)` | **Drop, re-point** at `search.model_endpoint(id)` — see §4. |
| `document` | `connector_id` | `public.knowledge_connector(id)` | **Drop.** Connectors stay in Studio (ADR 0002); the column stays as a plain remote id. |
| `kb_keyword` | `created_by_user_id` | *(no FK in Studio)* | Nothing to drop; the column is already plain text. |

Everything else — `document.knowledge_base_id`, `embedding.document_id`,
`kb_cluster.kb_id`, the two keyword link tables, `document_embed_batch` — points
*inside* the moving set and travels with it unchanged.

## 2. Column renames, and the one that is not just a rename

```sql
ALTER TABLE search.knowledge_base RENAME COLUMN user_id      TO owner_id;
ALTER TABLE search.knowledge_base RENAME COLUMN workspace_id TO paired_client_id;
```

`paired_client_id` is **NOT NULL** in Search's schema (ADR 0003: every row is
owned by a certificate) and Studio's `workspace_id` is nullable. Studio has
knowledge bases that predate workspaces and belong only to a user, and the
`SET NOT NULL` will refuse them.

**The migration has to decide what happens to those rows before it can run at
all.** They are not a rounding error to be deleted quietly. The options, in the
order they should be considered:

1. Map each one to the paired client of its owner's default workspace, if the
   owner has exactly one.
2. Leave them in Studio, unmigrated, and let Studio keep serving them from its
   in-process engine — which is what unpaired workspaces do anyway until
   TASK-014.
3. Fail the migration loudly, with the ids listed, and make it a decision a
   person takes.

The rehearsal (TASK-013) has to report the count before anything is written.

## 3. Index renames

`SET SCHEMA` keeps index names, and four of `knowledge_base`'s carry the old
vocabulary. Rename them with the columns, or the schema ends up describing
itself in words it no longer uses:

```sql
ALTER INDEX search.kb_user_id_idx              RENAME TO kb_owner_id_idx;
ALTER INDEX search.kb_workspace_id_idx         RENAME TO kb_paired_client_id_idx;
ALTER INDEX search.kb_user_workspace_idx       RENAME TO kb_owner_client_idx;
ALTER INDEX search.kb_workspace_name_active_unique RENAME TO kb_client_name_active_unique;
```

Those four names are what `packages/search/src/db/schema.ts` declares; a
mismatch will not break a query, and it will make every future
`drizzle-kit generate` propose to drop and recreate the index.

## 4. `model_endpoint` does not move

`search.model_endpoint` is **not** column-compatible with
`workspace_model_endpoints` and is not a `SET SCHEMA` target. It is a registry
Search owns, and in wired mode it is a **mirror the paired client pushes**
(ADR 0004) — `PUT /endpoints` with catalog metadata and a stable `external_id`,
no key.

| `workspace_model_endpoints` | `search.model_endpoint` |
|---|---|
| `workspace_id` | `paired_client_id` |
| `provider_id` | `provider` |
| `encrypted_api_key` (NOT NULL) | `key_ciphertext` (nullable — NULL when mirrored) |
| `model_name` | `model` |
| `dimensions` | `dimension` |
| `display_name` | `label` |
| `azure_api_version`, `vertex_project`, `vertex_location` | folded into `config` jsonb |
| — | `source` (`local` \| `mirrored`) |
| — | `external_id` (the client's own id) |

So the sequence is: Studio pushes its endpoints first, Search writes
`model_endpoint` rows with `source='mirrored'` and the pushed `external_id`,
**then** `knowledge_base.embedding_endpoint_id` / `inference_endpoint_id` are
re-mapped from Studio's ids to Search's, and only then can the two foreign keys
be added. A migration that moves `knowledge_base` before the endpoints exist has
nothing to point at.

## 5. Blobs

`document.file_url` points into Studio's bucket. Search owns its own (ADR 0006)
and Studio never writes to it, so the objects are **copied**, not re-owned, and
`file_url` is rewritten to the new keys. This is the slowest part of the
migration and the only part that is not a transaction; it should be idempotent
and resumable, and it should run before the row move so a half-copied bucket
leaves nothing pointing at a missing object.

## 6. Partitions

The `kb_embedding_<sha>` tables move by `SET SCHEMA` like the rest. Their names
do not change — the hash is of the KB id, which does not change — which is
exactly why every statement in the engine qualifies them by schema
(`kb/partition.ts::kbPartitionRef`): during the migration, and for as long as
Studio keeps running its own engine for unpaired workspaces, `public` and
`search` both hold a table by that name.

`partition.integration.test.ts` is the regression suite for that, and it is
worth re-reading before writing this migration: it plants exactly the collision
this section describes.

## 7. Order

1. Copy the blobs, rewrite nothing yet.
2. Create the paired clients.
3. Push and mirror the model endpoints.
4. Report — and decide on — the NULL-workspace knowledge bases (§2).
5. `SET SCHEMA` the ten tables and the partitions.
6. Drop the six cross-boundary foreign keys (§1).
7. Rename the columns and the indexes (§2, §3).
8. Re-map the endpoint ids, add the two new foreign keys, `SET NOT NULL` on
   `paired_client_id` (§4).
9. Rewrite `document.file_url` (§5).
10. Stamp Search's migration ledger so its own migrator treats the schema as
    already at baseline rather than trying to create it.

Step 10 is the one that is easy to forget and fails loudly, which is the good
kind of failure: `db/migrate.ts` runs at every boot.
