# deploy

- `Dockerfile` — the core service image. One stage: Node 24 runs the
  TypeScript directly, so there is nothing to compile.
- `docker-compose.yml` — the reference stack: Search plus the Postgres
  (pgvector), Redis and MinIO it owns standalone. Also what the test suites
  point at.
- `healthcheck.mjs` — the container probe. It calls `GET /v1/health`, pinned
  against the instance's own CA when the state volume has one and falling back
  to the bare handshake before it does (ADR 0008 D5).

```bash
export SEARCH_ENCRYPTION_KEY=$(openssl rand -hex 32)
docker compose -f deploy/docker-compose.yml up -d --wait
```

The `search-state` volume is the instance's identity — the CA, the server
certificate and the pairing material. Back it up; an instance that loses it
loses every pairing.

## The API and the worker

The `search` service runs both: the HTTPS API and the ingestion worker, in one
process (ADR 0010). That is the default because a container you cannot hand a
document to is not an installation of this product.

| | |
|---|---|
| `pnpm --filter @actana/search-core dev` | API + worker, watching for changes |
| `pnpm --filter @actana/search-core start:api` | the same entry point; set `SEARCH_WORKERS=off` to leave the jobs alone |
| `pnpm --filter @actana/search-core start:worker` | the worker alone |

To split them in compose, run two services off this image — the header of
`docker-compose.yml` has the snippet. Both halves need the database, Redis, the
`SEARCH_S3_*` block and `SEARCH_ENCRYPTION_KEY`; only the API needs
`SEARCH_PORT`, `SEARCH_PUBLIC_HOST` and the state volume. The worker scales
horizontally (`--scale search-worker=N`): every job on the queue is idempotent
and resumable, so a second worker is throughput rather than risk.

`SEARCH_QUEUE_PREFIX` (default `search`) namespaces every key Search writes into
Redis. Sharing a *client's* Redis needs no change — the prefix is what makes
that safe. Change it only when two Search instances share one Redis.

## The operator's socket

A pairing code is minted by the service, not by the CLI, and the CLI asks
through a Unix socket at `$SEARCH_STATE_DIR/admin.sock` — mode 0600 inside a
0700 directory, so the filesystem is what decides who may (ADR 0008 D6).

```bash
docker compose -f deploy/docker-compose.yml exec search \
  node packages/cli/bin/actana-search.mjs pair new --label laptop
```

`exec` puts the command inside the container, which is where the socket is.
Reaching it from the host means bind-mounting the state directory rather than
using a named volume.
