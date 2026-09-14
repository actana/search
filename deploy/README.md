# deploy

- `Dockerfile` — the core service image. One stage: Node 24 runs the
  TypeScript directly, so there is nothing to compile.
- `docker-compose.yml` — the reference stack: Search plus the Postgres
  (pgvector), Redis and MinIO it owns standalone. Also what the test suites
  point at.
- `healthcheck.mjs` — the container probe. It checks the TLS listener answers,
  which is all a probe without a client certificate can check (ADR 0003).

```bash
export SEARCH_ENCRYPTION_KEY=$(openssl rand -hex 32)
docker compose -f deploy/docker-compose.yml up -d --wait
```

The `search-state` volume is the instance's identity — the CA, the server
certificate and the pairing material. Back it up; an instance that loses it
loses every pairing.
