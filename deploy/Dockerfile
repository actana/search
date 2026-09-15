# actana/search — the core service.
#
# One stage, on purpose: the core runs its TypeScript directly under Node 24's
# own type stripping, so there is nothing to compile and nothing to copy out of
# a builder. The image is the workspace with production dependencies installed.
FROM node:24.19.0-bookworm-slim

ENV NODE_ENV=production \
    PNPM_HOME=/usr/local/bin \
    SEARCH_PORT=7443 \
    SEARCH_STATE_DIR=/var/lib/actana-search

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@12.4.1 --activate

# Manifests first so a dependency-free change does not invalidate the install
# layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/search/package.json  packages/search/
COPY packages/shared/package.json  packages/shared/
COPY packages/sdk/package.json     packages/sdk/
COPY packages/cli/package.json     packages/cli/

RUN pnpm install --frozen-lockfile --prod --ignore-scripts

COPY packages/ packages/
COPY scripts/ scripts/

# The probe, and only the probe.
#
# The image's own `HEALTHCHECK` below runs `/app/deploy/healthcheck.mjs` and
# `deploy/` was never copied, so the check failed with "Cannot find module" on
# every container this image has ever produced — `docker run --wait` never
# returned, a `depends_on: service_healthy` never fired, and an orchestrator
# restarted a working instance in a loop. Only the one file: `Dockerfile`,
# `docker-compose.yml` and `README.md` are what *builds* and *runs* the image,
# not what runs inside it, and an image that carries its own build context is
# an image whose contents nobody can account for.
COPY deploy/healthcheck.mjs deploy/

# The state directory holds the CA, the server certificate and the pairing
# material. Mount a volume over it — an instance that loses it loses its
# identity and every paired client has to pair again.
RUN mkdir -p "$SEARCH_STATE_DIR" && chown -R node:node "$SEARCH_STATE_DIR" /app
USER node

EXPOSE 7443

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "/app/deploy/healthcheck.mjs"]

CMD ["node", "packages/search/src/index.ts"]
