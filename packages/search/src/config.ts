/**
 * The service's configuration: every `SEARCH_*` variable, parsed once.
 *
 * Replaces Studio's `@/lib/core/config/env`. Two differences that matter:
 * the names are all `SEARCH_`-prefixed so a shared `.env` cannot cross the
 * boundary by accident, and the parse is **lazy** — read on first access, not
 * at import — because every lifted module imports this at module scope and a
 * test that never touches the database should not need a database URL.
 */

import { z } from "zod";

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : /^(1|true|yes|on)$/i.test(v)));

const schema = z.object({
  /** Postgres, with pgvector. Search owns the `search` schema in it (ADR 0002). */
  SEARCH_DATABASE_URL: z.string().min(1).optional(),
  /** Redis, for the ingestion queue. Prefixed `search` so a shared server is safe (ADR 0006). */
  SEARCH_REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  /**
   * The namespace every key Search writes into Redis sits under (ADR 0006,
   * ADR 0010).
   *
   * `search` is the answer for a deployment, standalone or wired: sharing a
   * client's Redis is safe because the two engines' keys cannot collide. It is
   * settable because two *Search* instances sharing one Redis — a test run
   * beside a dev instance, two branches on one machine — is a real arrangement,
   * and the alternative is a second Redis for the sake of a prefix.
   */
  SEARCH_QUEUE_PREFIX: z.string().min(1).default("search"),
  /**
   * Jobs one worker process runs at once on the knowledge queue. Mirrors
   * Studio's `worker/index.ts` knowledge concurrency.
   */
  SEARCH_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(20),

  /** The S3-compatible bucket Search owns. Never a client's bucket (ADR 0006). */
  SEARCH_S3_ENDPOINT: z.string().optional(),
  SEARCH_S3_BUCKET: z.string().default("search"),
  SEARCH_S3_ACCESS_KEY: z.string().optional(),
  SEARCH_S3_SECRET_KEY: z.string().optional(),
  SEARCH_S3_REGION: z.string().default("us-east-1"),
  SEARCH_S3_FORCE_PATH_STYLE: booleanish.default(true),

  /**
   * 32 bytes of hex. Seals provider keys held locally (ADR 0004). In wired
   * mode nothing is sealed here because nothing is stored here.
   */
  SEARCH_ENCRYPTION_KEY: z.string().optional(),

  SEARCH_PORT: z.coerce.number().int().positive().default(7443),
  SEARCH_PUBLIC_HOST: z.string().default("localhost"),
  /**
   * An **opt-in** loopback TCP port for the admin surface that mints pairing
   * codes and revokes clients (TASK-006).
   *
   * Unset by default, and that is the recommended setting: the admin surface
   * normally listens on a Unix socket at `$SEARCH_STATE_DIR/admin.sock`, mode
   * 0600, so what guards it is the filesystem — the same thing that guards the
   * CA key beside it. A loopback port is reachable by every process on the
   * host, containers sharing the network namespace included, and this surface
   * has no authentication of its own. Set it only where Unix sockets are not
   * available. Bound to `127.0.0.1` and nothing else when set.
   */
  SEARCH_ADMIN_PORT: z.coerce.number().int().nonnegative().optional(),
  /**
   * Plain HTTP, with the caller read from an `x-paired-client` header instead
   * of a certificate (ADR 0003 says identity is never read from a header, which
   * is exactly why this is not a deployment mode). For the fixture suites only:
   * the server refuses to start this way unless `NODE_ENV=test` or
   * `SEARCH_TEST_DATABASE_URL` is set.
   */
  SEARCH_DEV_INSECURE: booleanish.default(false),
  /**
   * Run the ingestion jobs **inside this process**, in worker order, with no
   * Redis and no worker process (`queue/inline.ts`).
   *
   * For the fixture suites only, and refused exactly the way
   * `SEARCH_DEV_INSECURE` is: {@link config} throws unless `NODE_ENV=test` or
   * `SEARCH_TEST_DATABASE_URL` is set, so a process that so much as reads its
   * configuration with this on does not start. A deployment that quietly ran
   * its ingestion inside its API process would look like it was working right
   * up until it was restarted mid-document.
   */
  SEARCH_INLINE_JOBS: booleanish.default(false),
  /** CA, server certificate, pairing material. The instance's identity. */
  SEARCH_STATE_DIR: z.string().optional(),
  SEARCH_LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),

  /**
   * Test-only deterministic embedder. `hash-ngram` replaces every provider
   * call with the 256-dimension token-n-gram hash in
   * `@actana/search-shared/testing/hash-ngram-embedder`, so a fixture suite
   * ranks identically on any machine with no key and no network.
   */
  SEARCH_TEST_EMBEDDING: z.enum(["hash-ngram"]).optional(),
  /** Integration suites run only when this is set; without it they skip. */
  SEARCH_TEST_DATABASE_URL: z.string().optional(),
});

export type SearchConfig = z.infer<typeof schema>;

/**
 * Is this a process a test-only mode may run in?
 *
 * **Allow-list, not a deny-list, and that is the change.** Refusing only under
 * `NODE_ENV=production` made every environment that forgot to set `NODE_ENV` —
 * a bare `node src/index.ts`, a container whose entrypoint drops it, a staging
 * box nobody labelled — an environment where one variable turns the mTLS wall
 * off and makes `x-paired-client` an identity. An unset `NODE_ENV` is the
 * default, so the default has to be the refusal.
 *
 * Two ways in, both of which a test run has and a deployment does not:
 * `NODE_ENV=test`, which every runner sets, and `SEARCH_TEST_DATABASE_URL`,
 * which is what this repository's integration suites gate on.
 *
 * Asked by `SEARCH_DEV_INSECURE` (`api/server.ts`) and by
 * `SEARCH_INLINE_JOBS` (`queue/inline.ts`, and {@link config} below). It lives
 * here because it is a question about the environment rather than about either
 * mode, and because two copies of the answer are two things to get wrong.
 */
export function inATestEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "test" || (env.SEARCH_TEST_DATABASE_URL ?? "") !== "";
}

/** Refuse to run the jobs in-process outside a test, and say what that mode is. */
function assertNotInlineJobs(): never {
  throw new Error(
    "SEARCH_INLINE_JOBS is set outside a test environment. That mode runs the ingestion jobs " +
      "inside this process instead of on a worker (queue/inline.ts), so a deployment would look " +
      "like it was working right up until it was restarted mid-document — it runs only where " +
      "NODE_ENV=test or SEARCH_TEST_DATABASE_URL is set.",
  );
}

let cached: SearchConfig | undefined;

/** The parsed configuration. Throws with every offending variable named. */
export function config(): SearchConfig {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid Search configuration:\n${problems}`);
  }
  // Not a `.refine` on the schema: the refusal is about the *environment* this
  // process is in rather than about the value, and a reader of the error wants
  // the sentence rather than a zod issue path.
  if (parsed.data.SEARCH_INLINE_JOBS && !inATestEnvironment()) assertNotInlineJobs();
  cached = parsed.data;
  return cached;
}

/** Drop the memoised parse. Tests that mutate `process.env` call this. */
export function resetConfig(): void {
  cached = undefined;
}

/**
 * The database URL, or a clear failure. Separate from `config()` because it is
 * the one variable with no sensible default and half a dozen call sites.
 */
export function databaseUrl(): string {
  const url = config().SEARCH_DATABASE_URL;
  if (!url) {
    throw new Error("SEARCH_DATABASE_URL is not set — Search has no database to run against.");
  }
  return url;
}

/** The environment variable name, for messages that have to name it. */
export const DATABASE_URL_VAR = "SEARCH_DATABASE_URL";

// ---------------------------------------------------------------------------
// The lifted engine's knobs
// ---------------------------------------------------------------------------

/**
 * The tuning constants and legacy provider credentials the lifted modules read
 * off `env`.
 *
 * Studio exposed a single validated `env` object and the engine reached into it
 * for a dozen names. Keeping that object — same property names — is what made
 * the lift a rewrite of imports rather than of every call site, so it is kept.
 *
 * Two naming rules, and the split is deliberate:
 *
 *   - **Search's own knobs are `SEARCH_`-prefixed.** `KB_CONFIG_BATCH_SIZE`
 *     reads `SEARCH_KB_CONFIG_BATCH_SIZE`, and so on. A shared `.env` between
 *     Studio and Search must not let one tune the other by accident.
 *   - **Third-party credentials keep their conventional names.**
 *     `OPENAI_API_KEY`, `AZURE_OPENAI_*`, `MISTRAL_API_KEY` and `OCR_AZURE_*`
 *     are read unprefixed because that is what every deployment already calls
 *     them and what the provider's own documentation says.
 *
 * These credentials serve the **v1 path only** — the instance-level embedding
 * and OCR fallbacks the engine had before endpoints existed, moved across
 * unchanged (ADR 0005). Everything on the v2 path resolves its key through a
 * `ModelEndpointSource` and never looks here (ADR 0004).
 */
const num = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export interface EngineEnv {
  /** Seconds a document may spend in processing before the sweep fails it. */
  KB_CONFIG_MAX_DURATION: number
  /** Chunks embedded in one provider request. */
  KB_CONFIG_BATCH_SIZE: number
  /** Concurrent embedding requests in flight. */
  KB_CONFIG_CONCURRENCY_LIMIT: number
  /** Documents chunked in parallel within one ingest. */
  KB_CONFIG_CHUNK_CONCURRENCY: number
  /** Target chunks per `document_embed_batch` row. */
  KB_CONFIG_EMBED_BATCH_CHUNKS: number
  /** Milliseconds between embedding batches. */
  KB_CONFIG_DELAY_BETWEEN_BATCHES: number
  /** Milliseconds between documents. */
  KB_CONFIG_DELAY_BETWEEN_DOCUMENTS: number
  /** Ingestion jobs one paired client may have in flight. */
  WORKSPACE_MAX_INFLIGHT_INGESTION_JOBS: number

  // v1 fallbacks — see the note above.
  OPENAI_API_KEY?: string
  AZURE_OPENAI_API_KEY?: string
  AZURE_OPENAI_ENDPOINT?: string
  AZURE_OPENAI_API_VERSION?: string
  KB_OPENAI_MODEL_NAME?: string
  MISTRAL_API_KEY?: string
  OCR_AZURE_API_KEY?: string
  OCR_AZURE_ENDPOINT?: string
  OCR_AZURE_MODEL_NAME?: string
}

/**
 * Read per access, not memoised: these are read at module scope by the lifted
 * modules, and a test that sets one in `beforeEach` must be able to.
 */
export const env: EngineEnv = new Proxy({} as EngineEnv, {
  get(_t, prop: string) {
    switch (prop) {
      case 'KB_CONFIG_MAX_DURATION':
        return num('SEARCH_KB_CONFIG_MAX_DURATION', 600)
      case 'KB_CONFIG_BATCH_SIZE':
        return num('SEARCH_KB_CONFIG_BATCH_SIZE', 2000)
      case 'KB_CONFIG_CONCURRENCY_LIMIT':
        return num('SEARCH_KB_CONFIG_CONCURRENCY_LIMIT', 50)
      case 'KB_CONFIG_CHUNK_CONCURRENCY':
        return num('SEARCH_KB_CONFIG_CHUNK_CONCURRENCY', 5)
      case 'KB_CONFIG_EMBED_BATCH_CHUNKS':
        return num('SEARCH_KB_CONFIG_EMBED_BATCH_CHUNKS', 256)
      case 'KB_CONFIG_DELAY_BETWEEN_BATCHES':
        return num('SEARCH_KB_CONFIG_DELAY_BETWEEN_BATCHES', 100)
      case 'KB_CONFIG_DELAY_BETWEEN_DOCUMENTS':
        return num('SEARCH_KB_CONFIG_DELAY_BETWEEN_DOCUMENTS', 50)
      case 'WORKSPACE_MAX_INFLIGHT_INGESTION_JOBS':
        return num('SEARCH_MAX_INFLIGHT_INGESTION_JOBS', 10)
      default:
        return process.env[prop]
    }
  },
})
