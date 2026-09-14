## Models

This directory holds the model-endpoint registry, the dispatchers, and the zod
schemas. New LLM hosts are normally added here as Templates — see below.

## Where an endpoint comes from

`source.ts` is the seam (ADR 0004). `ModelEndpointSource` has two
implementations: `LocalEndpointSource` reads `search.model_endpoint` with its
keys sealed under `SEARCH_ENCRYPTION_KEY`, and `MirroredEndpointSource`
(TASK-005) resolves a paired client's key per job and never stores it. Ingest
and query code asks for "the embedding endpoint this KB is bound to" and never
learns which it got.

`SEARCH_TEST_EMBEDDING=hash-ngram` replaces every embedding call with the
deterministic hash n-gram embedder in `@actana/search-shared/testing`. The gate
is in `executeWorkspaceEmbedding`, which is the one function every embedding
path reaches the provider through.

## What did not come from Studio

- **The inference half of the catalog.** Studio's `providers/models.ts` is 1,748
  lines of chat-model registry with pricing and capabilities. Search does not
  choose a model — it uses the endpoint a KB is bound to — so a catalog it
  cannot act on would only go stale. `provider-types.ts` keeps the *shapes* the
  embedding catalog is typed against, plus the three embedding price rows it
  cites. `getModel` and `listModels` keep their signatures and resolve
  embedding ids exactly as before; an inference id resolves to `null`.
- **`create-endpoint-from-config.ts`.** Studio's template installer (its plan
  08), which recreates an endpoint from a template's baked config. It belongs to
  Studio's template system, not to the engine.
- **The secret-backed key mode.** See the note in `endpoint-api-key.ts`.

## Adding a Template

A new LLM host that speaks an existing wire shape (OpenAI-compatible, Anthropic Messages, Google GenAI, Voyage, Cohere) is added as a Template inside `templates.ts` — touch one file, no migration, no dispatcher change. Pick the matching Provider, add a `Template` entry with `id`, `label`, `baseUrl`, `modelSuggestions`, optional `extraFields`, and the right `requestShape`.

A new wire shape requires a new Provider entry plus a dispatcher branch in `embedding.ts` and/or `inference.ts`.
