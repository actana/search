/**
 * @vitest-environment node
 *
 * Knowledge Base behaviour freeze (plan 14, TASK-001 in Studio; replayed here).
 *
 * Runs the **lifted** engine against a live pgvector Postgres and asserts the
 * results Studio recorded in `src/__fixtures__/kb-fixture.json` — a byte-for-byte
 * copy of its own. This is the evidence behind ADR 0005: not that behaviour is
 * identical, but that it is checked. TASK-004 replays the same fixture over
 * REST; anything that diverges between the two is a behaviour change, not a
 * refactor.
 *
 * Four knowledge bases, one corpus:
 *
 * - `hybrid`   — `processDocumentAsync`, the inline (non-BullMQ) fallback.
 * - `bullmq`   — `planDocumentEmbedding` → `processEmbedBatch` (per range) →
 *                `finalizeDocumentEmbedding` → `handleKeywordsExtract`, the
 *                production worker path (`worker/processors/knowledge.ts`).
 *                Asserted identical to `hybrid`, corpus and rankings alike.
 * - `sdk`      — `ingestDocument`, the SDK / runtime-route / block path.
 * - `defaults` — `ingestDocument` on a KB with no stored chunking config, so
 *                Studio's column default applies and the read path sits below
 *                the clustering cold start.
 *
 * Env-gated on `SEARCH_TEST_DATABASE_URL`. Without it the whole suite skips.
 *
 *     SEARCH_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/search_test \
 *       pnpm --filter @actana/search-core test
 *
 * Only the external calls are replaced, all through seams Studio already has:
 * embeddings come from the deterministic hash n-gram embedder, keyword
 * extraction from the deterministic topic extractor, and the queue producers
 * record their enqueues so the suite can drive the job handlers in worker
 * order. Every other line — chunking, partition DDL, the `embedding` and
 * partition writes, the batch ledger, cluster fitting, `queryKb`,
 * `handleKbQuery`, the v1 tag+vector util — is the production code path.
 *
 * lifted: the recorder. `KB_FIXTURE_RECORD=1` wrote the expectations back into
 * the fixture and reformatted it with Biome; here the fixture is an artefact
 * copied from Studio and Search must never rewrite it — a repo that can
 * re-record the evidence it is judged by proves nothing. Re-recording happens in
 * Studio, with an ADR, and the new file is copied across
 * (`src/__fixtures__/README.md`).
 *
 * Every object this suite creates is prefixed with a fresh run id and dropped
 * in `afterAll`, so it re-runs cleanly against a database that already holds
 * data.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.unmock('../db/client.ts')
vi.unmock('drizzle-orm')

const { enqueuedJobs, flowJobs } = vi.hoisted(() => ({
  enqueuedJobs: [] as Array<{ name: string; payload: unknown }>,
  flowJobs: [] as Array<Record<string, unknown>>,
}))

/**
 * Embedding seam. `lib/kb/ingest.ts`, `lib/kb/query.ts`,
 * `lib/knowledge/documents/service.ts`, `lib/knowledge/documents/embed-pipeline.ts`
 * and `lib/knowledge/chunks/service.ts` all reach the provider through this one
 * function.
 */
vi.mock('../models/embedding.ts', async () => {
  const { HASH_NGRAM_DIMS, hashNgramEmbedMany, hashNgramTokenCount } = await import(
    '@actana/search-shared/testing/hash-ngram-embedder'
  )
  return {
    executeWorkspaceEmbedding: vi.fn(
      async ({
        endpoint,
        input,
      }: {
        endpoint: { modelName?: string | null }
        input: string | string[]
      }) => {
        const tokens = hashNgramTokenCount(input)
        return {
          embeddings: hashNgramEmbedMany(input),
          model: endpoint.modelName ?? 'hash-ngram',
          dimensions: HASH_NGRAM_DIMS,
          usage: { promptTokens: tokens, totalTokens: tokens },
        }
      }
    ),
  }
})

/**
 * Inference seam. `lib/kb/keywords/extract.ts` builds Studio's real prompts and
 * parses the reply; the fake model answers with the strict JSON a compliant
 * model would return for the payload those prompts wrap.
 */
vi.mock('../models/inference.ts', async () => {
  const { keywordsResponseForPrompt } = await import('./testing/deterministic-keywords.ts')
  return {
    // lifted: `MAX_TOOL_ITERATIONS` and `executeProviderRequest` — the
    // deprecated `@/providers` re-export — went with `models/inference.ts`.
    executeWorkspaceInference: vi.fn(
      async ({ messages }: { messages: Array<{ role: string; content: string }> }) => {
        const user = messages.find((m) => m.role === 'user')?.content ?? ''
        return {
          content: keywordsResponseForPrompt(user),
          model: 'deterministic-keywords',
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        }
      }
    ),
  }
})

/**
 * File-parser seam. `lib/file-parsers/index.ts` lazy-loads every parser with
 * CommonJS `require()`, which Vitest's ESM transform cannot resolve — under the
 * test runner the registry comes up empty and every parse fails with
 * "Unsupported file type". This replacement wires the SAME parser
 * implementations through ESM imports; the parsing behaviour, including the
 * metadata that steers chunker selection in `processDocument`, is unchanged.
 * The parsers themselves are covered by `lib/file-parsers/index.test.ts`.
 */
vi.mock('@actana/search-shared/file-parsers/index', async () => {
  const nodePath = await import('node:path')
  const { readFile } = await import('node:fs/promises')
  const { CsvParser } = await import('@actana/search-shared/file-parsers/csv-parser')
  const { MdParser } = await import('@actana/search-shared/file-parsers/md-parser')
  const { TxtParser } = await import('@actana/search-shared/file-parsers/txt-parser')
  const { parseJSON, parseJSONBuffer } = await import('@actana/search-shared/file-parsers/json-parser')
  const { parseYAML, parseYAMLBuffer } = await import('@actana/search-shared/file-parsers/yaml-parser')

  const byExtension = {
    csv: new CsvParser(),
    md: new MdParser(),
    txt: new TxtParser(),
  } as const

  const parseBuffer = async (buffer: Buffer, extension: string) => {
    if (extension === 'json') return parseJSONBuffer(buffer)
    if (extension === 'yaml' || extension === 'yml') return parseYAMLBuffer(buffer)
    const parser = byExtension[extension as keyof typeof byExtension]
    if (!parser) throw new Error(`Unsupported file type: ${extension}`)
    return parser.parseBuffer(buffer)
  }

  return {
    PARSE_TIMEOUT_MS_PER_MB: 10_000,
    MIN_PARSE_TIMEOUT_MS: 30_000,
    MAX_PARSE_TIMEOUT_MS: 20 * 60 * 1000,
    computeParseTimeoutMs: () => 30_000,
    withParseTimeout: async <T>(parse: Promise<T>) => parse,
    isSupportedFileType: (extension: string) =>
      extension === 'json' ||
      extension === 'yaml' ||
      extension === 'yml' ||
      extension in byExtension,
    parseBuffer,
    parseFile: async (filePath: string) => {
      const extension = nodePath.extname(filePath).toLowerCase().slice(1)
      if (extension === 'json') return parseJSON(filePath)
      if (extension === 'yaml' || extension === 'yml') return parseYAML(filePath)
      const parser = byExtension[extension as keyof typeof byExtension]
      if (parser) return parser.parseFile(filePath)
      return parseBuffer(await readFile(filePath), extension)
    },
  }
})

/**
 * Record enqueues instead of dispatching them, then invoke the job handlers
 * explicitly and in order below. That is what a worker does, minus the timing
 * non-determinism of an inline `queueMicrotask` backend.
 */
// lifted: Studio mocked `@/lib/core/async-jobs/config` and `@actana/queue`
// separately, and its binary backend dispatch (`getAsyncBackendType`,
// `shouldExecuteInline`, `resetJobQueueCache`) with it. Both modules are
// `queue/index.ts` here and Search has one backend, so the two factories are
// one — a second `vi.mock` of the same path would silently replace the first.
vi.mock('../queue/index.ts', () => ({
  QUEUE_NAMES: { knowledge: 'search-knowledge' },
  JOB_TYPE_ATTEMPTS: {},
  getQueue: () => ({ add: async () => ({ id: 'queued' }) }),
  getFlowProducer: () => ({
    add: async (flow: Record<string, unknown>) => {
      flowJobs.push(flow)
      return { job: { id: `flow-${flowJobs.length}` } }
    },
  }),
  getJobQueue: async () => ({
    enqueue: async (name: string, payload: unknown) => {
      enqueuedJobs.push({ name, payload })
      return `job-${enqueuedJobs.length}`
    },
  }),
}))

/*
 * The flow producer is folded into the single queue mock above.
 * `planDocumentEmbedding` fans out one `kb.embed.batch` child per chunk range
 * under a `kb.embed.finalize` parent; recording the flow lets the suite run
 * those handlers itself, children first then the parent — the order BullMQ
 * guarantees and a worker dispatches.
 */

import { db } from '../db/client.ts'
import {
  document,
  documentEmbedBatch,
  embedding,
  kbCluster,
  knowledgeBase,
  modelEndpoint,
  pairedClient,
} from '../db/schema.ts'
import { asc, eq, sql } from 'drizzle-orm'
import { resetQueueConnection } from '../queue/redis.ts'
import { generateId, generateShortId } from '@actana/search-shared/short-id'
import { dropKbPartition, provisionKbPartition } from './ddl.ts'
import { ingestDocument, selectChunker } from './ingest.ts'
import { handleClustersValidate } from './jobs/clusters-validate.ts'
import { handleKeywordsExtract } from './jobs/keywords-extract.ts'
import { listKbKeywords } from './keywords/index.ts'
import { kbPartitionRef } from './partition.ts'
import { queryKb } from './query.ts'
import { handleKbQuery } from './query-handler.ts'
import { TOPIC_VOCABULARY } from './testing/deterministic-keywords.ts'
import {
  HASH_NGRAM_DIMS,
  HASH_NGRAM_KIND,
  HASH_NGRAM_VERSION,
  hashNgramEmbed,
} from '@actana/search-shared/testing/hash-ngram-embedder'
import {
  type EmbedBatchPayload,
  type EmbedFinalizePayload,
  finalizeDocumentEmbedding,
  planDocumentEmbedding,
  processEmbedBatch,
} from '../knowledge/documents/embed-pipeline.ts'
import { processDocumentAsync } from '../knowledge/documents/service.ts'
import type { StructuredFilter } from '../knowledge/types.ts'
import { getQueryStrategy, handleTagAndVectorSearch } from '../v1/knowledge-search-utils.ts'
import { resetConfig } from '../config.ts'
import { runMigrations } from '../db/migrate.ts'

const TEST_DATABASE_URL = process.env.SEARCH_TEST_DATABASE_URL
const describeDb = TEST_DATABASE_URL ? describe : describe.skip

/** The copy of Studio's fixture that ships with this package. */
const FIXTURE_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../__fixtures__')
const FIXTURE_PATH = path.join(FIXTURE_DIR, 'kb-fixture.json')

type KbKey = 'hybrid' | 'bullmq' | 'sdk' | 'defaults'

interface FixtureDocument {
  id: string
  path: string
  filename: string
  mimeType: string
  knowledgeBases: KbKey[]
  tags: Record<string, string | number | boolean>
  metadata: Record<string, unknown>
}

interface FixtureQuery {
  id: string
  knowledgeBase: KbKey
  api: 'queryKb' | 'handleKbQuery' | 'handleTagAndVectorSearch'
  text: string
  params: Record<string, unknown>
  probe: string
  expectedTop5: Array<{ documentId: string; chunkIndex: number }>
}

interface Fixture {
  fixtureVersion: number
  embedder: { kind: string; dims: number; version: number }
  keywordExtractor: { vocabularySize: number; vocabulary: string[] }
  chunking: {
    method: string
    chunkSize: number
    maxSize: number
    minSize: number
    overlap: number
    language: string
  }
  documents: FixtureDocument[]
  queries: FixtureQuery[]
  expectations: {
    corpus: Record<string, number> | null
    keywordVocabulary: string[] | null
    sdkPath: Record<string, unknown> | null
    defaultsPath: Record<string, unknown> | null
    bullmqParity: Record<string, unknown> | null
    queries?: Record<string, unknown>
  }
}

const fixture: Fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))

/** Unique per run so the suite never collides with itself or with real data. */
const RUN = generateShortId(8)
const PREFIX = `searchfx-${RUN}`

const ids = {
  // lifted: `user` and `workspace` became one `pairedClient`. Search has no user
  // table and does not know what a workspace is (ADR 0002/0003); who owns a row
  // is the client certificate that created it, and `owner_id` is plain text, so
  // the fixture's user id survives as a string with nothing behind it.
  owner: `${PREFIX}-owner`,
  pairedClient: `${PREFIX}-client`,
  embeddingEndpoint: `${PREFIX}-emb`,
  inferenceEndpoint: `${PREFIX}-inf`,
}

/** Knowledge-base key → database id. */
const kbIds: Record<KbKey, string> = {
  hybrid: `${PREFIX}-kb-hybrid`,
  bullmq: `${PREFIX}-kb-bullmq`,
  sdk: `${PREFIX}-kb-sdk`,
  defaults: `${PREFIX}-kb-defaults`,
}
const KB_KEYS = Object.keys(kbIds) as KbKey[]

/** database document id → fixture document id, for translating results back. */
const reverseDocumentIds = new Map<string, string>()

/** What the run produced. Kept for a failure message to read; never written back. */
const recorded: {
  corpus: Record<string, number>
  keywordVocabulary: string[]
  sdkPath: Record<string, unknown>
  defaultsPath: Record<string, unknown>
  bullmqParity: Record<string, unknown>
  queries: Record<string, unknown>
} = {
  corpus: {},
  keywordVocabulary: [],
  sdkPath: {},
  defaultsPath: {},
  bullmqParity: {},
  queries: {},
}

interface FrozenMatch {
  documentId: string
  chunkIndex: number
}

/** Translate engine matches into fixture-stable `{ documentId, chunkIndex }`. */
function freeze(matches: Array<{ documentId: string; chunkIndex: number }>): FrozenMatch[] {
  return matches.map((m) => ({
    documentId: reverseDocumentIds.get(m.documentId) ?? `UNKNOWN(${m.documentId})`,
    chunkIndex: m.chunkIndex,
  }))
}

/** Count the rows in a KB's vector partition. */
async function partitionRowCount(kbId: string): Promise<number> {
  const table = kbPartitionRef(kbId)
  const res = (await db.execute(sql.raw(`SELECT count(*)::int AS c FROM ${table}`))) as
    | { rows?: Array<{ c: number }> }
    | Array<{ c: number }>
  const rows = Array.isArray(res) ? res : (res.rows ?? [])
  return Number(rows[0]?.c ?? 0)
}

/** Rows in a KB's partition that carry a cluster assignment. */
async function partitionClusteredCount(kbId: string): Promise<number> {
  const table = kbPartitionRef(kbId)
  const res = (await db.execute(
    sql.raw(`SELECT count(*)::int AS c FROM ${table} WHERE cluster_id IS NOT NULL`)
  )) as { rows?: Array<{ c: number }> } | Array<{ c: number }>
  const rows = Array.isArray(res) ? res : (res.rows ?? [])
  return Number(rows[0]?.c ?? 0)
}

/** Rows in a KB's shared `embedding` table. */
async function sharedRowCount(kbId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(embedding)
    .where(eq(embedding.knowledgeBaseId, kbId))
  return Number(rows[0]?.count ?? 0)
}

interface QueryParams {
  topK?: number
  keywordWeight?: number
  neighborClusters?: number
  filter?: Record<string, unknown>
  minScore?: number
  includeContent?: boolean
  includeDiagnostics?: boolean
}

/** Run one fixture query against an explicit KB, through its declared API. */
async function runV2Query(query: FixtureQuery, kbId: string) {
  const params = query.params as QueryParams
  return query.api === 'handleKbQuery'
    ? handleKbQuery(
        { pairedClientId: ids.pairedClient, source: 'sdk' },
        { kbId, text: query.text, ...params }
      )
    : queryKb({ kbId, text: query.text, ...params })
}

/** Run the v1 tag+vector query against an explicit KB. */
async function runV1Query(query: FixtureQuery, kbId: string) {
  const params = query.params as { topK: number; structuredFilters: StructuredFilter[] }
  /**
   * `hashNgramEmbed` here is the same vector the route would get: the v1 route
   * embeds the query through `executeWorkspaceEmbedding`, which this suite has
   * mocked onto exactly this function. Calling it directly only skips the
   * endpoint lookup the util does not take part in.
   */
  const queryVector = `[${hashNgramEmbed(query.text).join(',')}]`
  const strategy = getQueryStrategy(1, params.topK)
  const results = await handleTagAndVectorSearch({
    knowledgeBaseIds: [kbId],
    topK: params.topK,
    structuredFilters: params.structuredFilters,
    queryVector,
    distanceThreshold: strategy.distanceThreshold,
  })
  return { results, strategy }
}

describeDb('KB behaviour freeze (fixture suite)', () => {
  beforeAll(async () => {
    process.env.SEARCH_DATABASE_URL = TEST_DATABASE_URL as string
    resetConfig()

    // Search applies its own migrations at boot (ADR 0002); the suite does the
    // same rather than assuming a migrated database, so a fresh `search_test`
    // works.
    await runMigrations({ url: TEST_DATABASE_URL as string })

    /** The fixture's declared embedder must be the one this suite injects. */
    expect(fixture.embedder).toMatchObject({
      kind: HASH_NGRAM_KIND,
      dims: HASH_NGRAM_DIMS,
      version: HASH_NGRAM_VERSION,
    })
    /** …and its inlined keyword vocabulary must be the extractor's own list. */
    expect(fixture.keywordExtractor.vocabulary).toEqual([...TOPIC_VOCABULARY])
    expect(fixture.keywordExtractor.vocabularySize).toBe(TOPIC_VOCABULARY.size)

    const now = new Date()

    // lifted: the `user` + `workspace` + `workspace_model_endpoints` triple
    // became one paired client and two `model_endpoint` rows.
    await db.insert(pairedClient).values({
      id: ids.pairedClient,
      label: `${PREFIX} client`,
      certSerial: `${PREFIX}-serial`,
      certFingerprint: `${PREFIX}-fingerprint`,
      scope: 'admin',
      status: 'active',
      createdAt: now,
    })

    await db.insert(modelEndpoint).values([
      {
        id: ids.embeddingEndpoint,
        pairedClientId: ids.pairedClient,
        provider: 'fixture',
        keyCiphertext: null,
        template: 'fixture-hash-ngram',
        model: 'hash-ngram-256',
        kind: 'embedding',
        dimension: HASH_NGRAM_DIMS,
        source: 'local',
        config: {},
        createdAt: now,
        updatedAt: now,
      },
      {
        id: ids.inferenceEndpoint,
        pairedClientId: ids.pairedClient,
        provider: 'fixture',
        keyCiphertext: null,
        template: 'fixture-deterministic-keywords',
        model: 'deterministic-keywords',
        kind: 'inference',
        source: 'local',
        config: {},
        createdAt: now,
        updatedAt: now,
      },
    ])

    const chunkingConfig = {
      method: fixture.chunking.method,
      chunkSize: fixture.chunking.chunkSize,
      maxSize: fixture.chunking.maxSize,
      minSize: fixture.chunking.minSize,
      overlap: fixture.chunking.overlap,
    }

    for (const key of KB_KEYS) {
      const base = {
        id: kbIds[key],
        ownerId: ids.owner,
        pairedClientId: ids.pairedClient,
        name: `${PREFIX} ${key}`,
        embeddingModel: 'hash-ngram-256',
        embeddingDimension: HASH_NGRAM_DIMS,
        embeddingEndpointId: ids.embeddingEndpoint,
        inferenceEndpointId: ids.inferenceEndpoint,
        kmeansK: 8,
        language: fixture.chunking.language,
        createdAt: now,
        updatedAt: now,
      }
      /**
       * `defaults` is inserted WITHOUT `chunkingConfig`, so the
       * `knowledge_base.chunking_config` column default applies — the shape a
       * KB created through Studio's UI actually stores.
       */
      await db.insert(knowledgeBase).values(key === 'defaults' ? base : { ...base, chunkingConfig })
      await provisionKbPartition({
        kbId: kbIds[key],
        dim: HASH_NGRAM_DIMS,
        language: fixture.chunking.language,
      })
    }

    const docsFor = (key: KbKey) => fixture.documents.filter((d) => d.knowledgeBases.includes(key))

    /** Insert the `document` row a file-backed ingestion path expects to find. */
    const insertDocumentRow = async (key: KbKey, doc: FixtureDocument) => {
      const absolute = path.join(FIXTURE_DIR, doc.path)
      const bytes = readFileSync(absolute)
      const documentId = generateId()
      reverseDocumentIds.set(documentId, doc.id)
      await db.insert(document).values({
        id: documentId,
        knowledgeBaseId: kbIds[key],
        filename: doc.filename,
        fileUrl: absolute,
        fileSize: bytes.length,
        mimeType: doc.mimeType,
        processingStatus: 'pending',
        enabled: true,
        includedInKb: true,
        uploadedAt: now,
        ...doc.tags,
      })
      return { documentId, absolute, fileSize: bytes.length }
    }

    /**
     * `hybrid` — the inline fallback. Parses the fixture markdown, JSON and CSV
     * straight off disk (`parseFile` accepts a local path), chunks it, embeds
     * it, writes the shared `embedding` rows with the document's tags and the
     * partition rows with the same ids, then extracts keywords inline.
     */
    for (const doc of docsFor('hybrid')) {
      const { documentId, absolute, fileSize } = await insertDocumentRow('hybrid', doc)
      await processDocumentAsync(kbIds.hybrid, documentId, {
        filename: doc.filename,
        fileUrl: absolute,
        fileSize,
        mimeType: doc.mimeType,
      })
    }

    /**
     * `bullmq` — the production worker path. `planDocumentEmbedding` stages the
     * chunks and fans out a flow; the suite then runs each recorded child
     * (`kb.embed.batch`) and the parent (`kb.embed.finalize`) in the order
     * BullMQ would, and finally the `kb-keywords-extract` job finalize
     * enqueues.
     */
    for (const doc of docsFor('bullmq')) {
      const { documentId, absolute, fileSize } = await insertDocumentRow('bullmq', doc)
      flowJobs.length = 0
      await planDocumentEmbedding({
        knowledgeBaseId: kbIds.bullmq,
        documentId,
        docData: {
          filename: doc.filename,
          fileUrl: absolute,
          fileSize,
          mimeType: doc.mimeType,
        },
        processingOptions: {},
        requestId: `${PREFIX}-${doc.id}`,
      })

      expect(flowJobs).toHaveLength(1)
      const flow = flowJobs[0] as {
        name: string
        data: { payload: EmbedFinalizePayload }
        children: Array<{ name: string; data: { payload: EmbedBatchPayload } }>
      }
      expect(flow.name).toBe('kb.embed.finalize')
      expect(flow.children.length).toBeGreaterThan(0)
      for (const child of flow.children) {
        expect(child.name).toBe('kb.embed.batch')
        await processEmbedBatch(child.data.payload)
      }
      await finalizeDocumentEmbedding(flow.data.payload)

      const keywordJob = enqueuedJobs.filter(
        (j) =>
          j.name === 'kb-keywords-extract' &&
          (j.payload as { documentId?: string }).documentId === documentId
      )
      expect(keywordJob).toHaveLength(1)
      await handleKeywordsExtract({ documentId, knowledgeBaseId: kbIds.bullmq })
    }

    /**
     * Clustering. Both file-backed paths enqueue `kb.clusters.validate` once
     * the per-KB queue drains; the recorder above captured those enqueues and
     * the handler runs here, exactly as the worker would.
     */
    expect(enqueuedJobs.some((j) => j.name === 'kb.clusters.validate')).toBe(true)
    await handleClustersValidate({ kbId: kbIds.hybrid })
    await handleClustersValidate({ kbId: kbIds.bullmq })

    /**
     * `sdk` and `defaults` — the `ingestDocument` path, plus the keyword worker
     * it enqueues. `ingestDocument` creates the `document` row itself and takes
     * the text directly, so there is no file-backed row to pre-insert.
     */
    for (const key of ['sdk', 'defaults'] as const) {
      for (const doc of docsFor(key)) {
        const text = readFileSync(path.join(FIXTURE_DIR, doc.path), 'utf8')
        const result = await ingestDocument({
          kbId: kbIds[key],
          text,
          filename: doc.filename,
          mimeType: doc.mimeType,
          metadata: doc.metadata,
          includedInKb: true,
        })
        reverseDocumentIds.set(result.documentId, doc.id)
        await handleKeywordsExtract({
          documentId: result.documentId,
          knowledgeBaseId: kbIds[key],
        })
      }
    }
  }, 600_000)

  afterAll(async () => {
    try {
      for (const key of KB_KEYS) {
        await dropKbPartition({ kbId: kbIds[key] })
        await db.delete(knowledgeBase).where(eq(knowledgeBase.id, kbIds[key]))
      }
      await db.delete(modelEndpoint).where(eq(modelEndpoint.pairedClientId, ids.pairedClient))
      await db.delete(pairedClient).where(eq(pairedClient.id, ids.pairedClient))
    } finally {
      await resetQueueConnection()
    }

  }, 120_000)

  it('builds the corpus the fixture describes', async () => {
    const clusters = await db
      .select({ clusterId: kbCluster.clusterId, kbId: kbCluster.kbId })
      .from(kbCluster)

    const countFor = (key: KbKey) =>
      fixture.documents.filter((d) => d.knowledgeBases.includes(key)).length

    const corpus = {
      hybridDocuments: countFor('hybrid'),
      hybridEmbeddingRows: await sharedRowCount(kbIds.hybrid),
      hybridPartitionRows: await partitionRowCount(kbIds.hybrid),
      hybridClusteredRows: await partitionClusteredCount(kbIds.hybrid),
      bullmqDocuments: countFor('bullmq'),
      bullmqEmbeddingRows: await sharedRowCount(kbIds.bullmq),
      bullmqPartitionRows: await partitionRowCount(kbIds.bullmq),
      bullmqClusteredRows: await partitionClusteredCount(kbIds.bullmq),
      sdkDocuments: countFor('sdk'),
      sdkPartitionRows: await partitionRowCount(kbIds.sdk),
      defaultsDocuments: countFor('defaults'),
      defaultsPartitionRows: await partitionRowCount(kbIds.defaults),
    }
    recorded.corpus = corpus

    /** The shared table and the partition must stay row-for-row aligned. */
    expect(corpus.hybridPartitionRows).toBe(corpus.hybridEmbeddingRows)
    expect(corpus.bullmqPartitionRows).toBe(corpus.bullmqEmbeddingRows)
    /** Clustering needs at least COLD_START_MIN_CHUNKS (50) rows to engage. */
    expect(corpus.hybridPartitionRows).toBeGreaterThanOrEqual(50)
    expect(corpus.hybridClusteredRows).toBe(corpus.hybridPartitionRows)
    expect(corpus.bullmqClusteredRows).toBe(corpus.bullmqPartitionRows)
    /** …and the `defaults` KB must stay below it, so no clusters are fitted. */
    expect(corpus.defaultsPartitionRows).toBeLessThan(50)
    expect(clusters.filter((c) => c.kbId === kbIds.defaults)).toHaveLength(0)

    /**
     * The cluster COUNT is deliberately not frozen. `handleClustersValidate`
     * calls `validateK` / `runClustering` without a seed, so D² seeding falls
     * back to `Math.random` and the silhouette-chosen `k` varies between runs.
     * Ranking is unaffected: below CLUSTER_PRUNE_MIN_CHUNKS the read path never
     * prunes to clusters (see q06).
     */
    expect(clusters.filter((c) => c.kbId === kbIds.hybrid).length).toBeGreaterThanOrEqual(2)
    expect(clusters.filter((c) => c.kbId === kbIds.bullmq).length).toBeGreaterThanOrEqual(2)

    if (fixture.expectations.corpus) {
      expect(corpus).toEqual(fixture.expectations.corpus)
    }
  })

  it('the BullMQ worker path builds the same corpus as the inline fallback', async () => {
    const batches = await db
      .select({ status: documentEmbedBatch.status })
      .from(documentEmbedBatch)
      .where(eq(documentEmbedBatch.knowledgeBaseId, kbIds.bullmq))
    const docs = await db
      .select({
        filename: document.filename,
        chunkCount: document.chunkCount,
        processingStatus: document.processingStatus,
        keywordStatus: document.keywordStatus,
      })
      .from(document)
      .where(eq(document.knowledgeBaseId, kbIds.bullmq))
      .orderBy(asc(document.filename))
    const hybridDocs = await db
      .select({
        filename: document.filename,
        chunkCount: document.chunkCount,
        processingStatus: document.processingStatus,
        keywordStatus: document.keywordStatus,
      })
      .from(document)
      .where(eq(document.knowledgeBaseId, kbIds.hybrid))
      .orderBy(asc(document.filename))

    const vocabularyOf = async (kbId: string) =>
      (await listKbKeywords({ kbId, limit: 500, sort: 'usage_desc' })).map((k) => k.keyword).sort()
    const bullmqVocabulary = await vocabularyOf(kbIds.bullmq)

    /** Per-document chunk counts, statuses and vocabulary all agree. */
    expect(docs).toEqual(hybridDocs)
    expect(batches.length).toBeGreaterThan(0)
    expect(batches.every((b) => b.status === 'completed')).toBe(true)
    expect(bullmqVocabulary).toEqual(await vocabularyOf(kbIds.hybrid))

    recorded.bullmqParity = {
      embedBatchRows: batches.length,
      embedBatchStatuses: [...new Set(batches.map((b) => b.status))].sort(),
      documents: docs,
      keywordVocabularySize: bullmqVocabulary.length,
    }
  })

  it('extracts a stable keyword vocabulary on the hybrid path', async () => {
    const vocabulary = await listKbKeywords({
      kbId: kbIds.hybrid,
      limit: 500,
      sort: 'usage_desc',
    })
    const canonicals = vocabulary.map((k) => k.keyword).sort()
    recorded.keywordVocabulary = canonicals

    expect(canonicals.length).toBeGreaterThan(20)
    /**
     * The whole vocabulary must fit inside Studio's query-time keyword menu
     * (EXISTING_KEYWORDS_TOP_N = 100). Past that limit `listKbKeywords` orders
     * by `usage_count DESC` with no tie-break, and which keywords survive the
     * cut stops being reproducible.
     */
    expect(canonicals.length).toBeLessThanOrEqual(100)
    /** Every canonical form is a single lowercase token or one hyphenated pair. */
    for (const keyword of canonicals) {
      expect(keyword).toMatch(/^[^\s]+$/)
      expect(keyword).toBe(keyword.toLowerCase())
    }

    if (fixture.expectations.keywordVocabulary) {
      expect(canonicals).toEqual(fixture.expectations.keywordVocabulary)
    }
  })

  it('freezes the ingestDocument (SDK) path, including its empty keyword vocabulary', async () => {
    const docs = await db
      .select({
        filename: document.filename,
        chunkCount: document.chunkCount,
        processingStatus: document.processingStatus,
        keywordStatus: document.keywordStatus,
      })
      .from(document)
      .where(eq(document.knowledgeBaseId, kbIds.sdk))
      .orderBy(asc(document.filename))

    const vocabulary = await listKbKeywords({ kbId: kbIds.sdk, limit: 500, sort: 'usage_desc' })

    const sdkPath = {
      documents: docs,
      partitionRows: await partitionRowCount(kbIds.sdk),
      sharedEmbeddingRows: await sharedRowCount(kbIds.sdk),
      keywordVocabularySize: vocabulary.length,
    }
    recorded.sdkPath = sdkPath

    /**
     * Frozen quirk: `ingestDocument` writes only the partition, so the keyword
     * worker — which reads the shared `embedding` table — finds nothing and the
     * vocabulary stays empty. Documented in fixtures/README.md.
     */
    expect(sdkPath.partitionRows).toBeGreaterThan(0)
    expect(sdkPath.sharedEmbeddingRows).toBe(0)
    expect(sdkPath.keywordVocabularySize).toBe(0)

    if (fixture.expectations.sdkPath) {
      expect(sdkPath).toEqual(fixture.expectations.sdkPath)
    }
  })

  it("freezes Studio's default chunking on a KB with no stored config", async () => {
    const [row] = await db
      .select({ chunkingConfig: knowledgeBase.chunkingConfig })
      .from(knowledgeBase)
      .where(eq(knowledgeBase.id, kbIds.defaults))

    const docs = await db
      .select({ filename: document.filename, chunkCount: document.chunkCount })
      .from(document)
      .where(eq(document.knowledgeBaseId, kbIds.defaults))
      .orderBy(asc(document.filename))

    const defaultsPath = {
      storedChunkingConfig: row?.chunkingConfig ?? null,
      documents: docs,
      partitionRows: await partitionRowCount(kbIds.defaults),
      sharedEmbeddingRows: await sharedRowCount(kbIds.defaults),
    }
    recorded.defaultsPath = defaultsPath

    /**
     * The column default is what a UI-created KB stores. Note `minSize: 1`
     * here against the `?? 100` code fallback in `service.ts` /
     * `embed-pipeline.ts`: a UI-created KB and a code-defaulted KB disagree.
     */
    expect(defaultsPath.storedChunkingConfig).toEqual({
      maxSize: 1024,
      minSize: 1,
      overlap: 200,
    })

    /**
     * And the `ingest.ts` fallbacks a KB only reaches when its config object
     * omits the keys outright — 1024 tokens with 128 of overlap. The column
     * default supplies `overlap: 200`, so `DEFAULT_CHUNK_OVERLAP` is
     * unreachable for any KB created through the UI.
     */
    const nullConfigChunks = await selectChunker(
      'probe.md',
      undefined,
      null
    )(readFileSync(path.join(FIXTURE_DIR, 'docs/handbook-parental-leave.md'), 'utf8'))
    const explicitDefaultChunks = await selectChunker('probe.md', undefined, {
      chunkSize: 1024,
      overlap: 128,
    })(readFileSync(path.join(FIXTURE_DIR, 'docs/handbook-parental-leave.md'), 'utf8'))
    expect(nullConfigChunks).toEqual(explicitDefaultChunks)

    if (fixture.expectations.defaultsPath) {
      expect(defaultsPath).toEqual(fixture.expectations.defaultsPath)
    }
  })

  const v2Queries = fixture.queries.filter((q) => q.api !== 'handleTagAndVectorSearch')
  for (const query of v2Queries) {
    it(`${query.id}: ${query.probe}`, async () => {
      const params = query.params as QueryParams
      const result = await runV2Query(query, kbIds[query.knowledgeBase])

      const top5 = freeze(result.matches)
      recorded.queries[query.id] = {
        top5,
        matchCount: result.matches.length,
        scores: result.matches.map((m) => Number(m.score.toFixed(6))),
        keywordScores: result.matches.map((m) => Number(m.keywordScore.toFixed(6))),
        candidateClusterIds: result.diagnostics?.candidateClusterIds ?? null,
        queryKeywords: result.diagnostics?.queryKeywords ?? null,
      }

      /** Returned shape: the contract every caller in Studio reads. */
      expect(result.matches.length).toBeLessThanOrEqual(params.topK ?? 5)
      for (const match of result.matches) {
        expect(match).toMatchObject({
          id: expect.any(String),
          documentId: expect.any(String),
          chunkIndex: expect.any(Number),
          score: expect.any(Number),
          semanticScore: expect.any(Number),
          keywordScore: expect.any(Number),
        })
        expect(match.metadata).toBeTypeOf('object')
        if (params.includeContent === false) {
          expect(match.content).toBeNull()
        } else {
          expect(typeof match.content).toBe('string')
        }
        expect(match.score).toBeGreaterThanOrEqual(0)
        expect(match.score).toBeLessThanOrEqual(1)
        if (typeof params.minScore === 'number') {
          expect(match.score).toBeGreaterThanOrEqual(params.minScore)
        }
      }
      expect(result.usage?.embed.totalTokens).toBeGreaterThan(0)
      expect(result.usage?.keywords).toEqual({ promptTokens: 0, totalTokens: 0 })

      /** Ranking: monotonically non-increasing blended score. */
      for (let i = 1; i < result.matches.length; i++) {
        expect(result.matches[i - 1].score).toBeGreaterThanOrEqual(result.matches[i].score)
      }

      if (query.id === 'q06-neighbor-clusters' || query.id === 'q14-defaults-cold-start') {
        /**
         * q06: clusters exist but the read path never prunes below
         * CLUSTER_PRUNE_MIN_CHUNKS. q14: no clusters were fitted at all.
         */
        expect(result.diagnostics?.candidateClusterIds).toBeNull()
      }

      if (query.id === 'q11-sdk-keyword-pure') {
        /** No vocabulary → no query keywords → keywordWeight forced to 0. */
        expect(result.diagnostics?.queryKeywords ?? []).toEqual([])
        expect(result.matches.every((m) => m.keywordScore === 0)).toBe(true)
      }

      if (query.expectedTop5.length > 0) {
        expect(top5).toEqual(query.expectedTop5)
      }
    }, 60_000)
  }

  it('q11-sdk-keyword-pure: keywordWeight is a no-op without a vocabulary', async () => {
    const query = fixture.queries.find((q) => q.id === 'q11-sdk-keyword-pure') as FixtureQuery
    const pureKeyword = await runV2Query(query, kbIds.sdk)
    const pureSemantic = await runV2Query(
      { ...query, params: { topK: 5, keywordWeight: 0 } },
      kbIds.sdk
    )
    expect(freeze(pureKeyword.matches)).toEqual(freeze(pureSemantic.matches))
  }, 60_000)

  it('q05-metadata-filter: `filter` is accepted and changes nothing', async () => {
    const query = fixture.queries.find((q) => q.id === 'q05-metadata-filter') as FixtureQuery
    const withFilter = await runV2Query(query, kbIds.sdk)
    const withoutFilter = await runV2Query({ ...query, params: { topK: 5 } }, kbIds.sdk)
    expect(freeze(withFilter.matches)).toEqual(freeze(withoutFilter.matches))

    /**
     * The metadata is genuinely there to filter on — `ingestDocument` wrote it
     * into every partition row (ingest.ts:332) — which is what makes the no-op
     * a defect rather than a missing input.
     */
    expect(withFilter.matches.length).toBeGreaterThan(0)
    for (const match of withFilter.matches) {
      expect(match.metadata).toMatchObject({ category: expect.any(String) })
    }
  }, 60_000)

  it('q06-neighbor-clusters: neighborClusters does not change the result', async () => {
    const text = 'chunk overlap and vector retrieval blending'
    const wide = await queryKb({ kbId: kbIds.hybrid, text, topK: 5, neighborClusters: 4 })
    const narrow = await queryKb({ kbId: kbIds.hybrid, text, topK: 5, neighborClusters: 0 })
    expect(freeze(wide.matches)).toEqual(freeze(narrow.matches))
  }, 60_000)

  const v1Query = fixture.queries.find((q) => q.api === 'handleTagAndVectorSearch') as FixtureQuery
  it(`${v1Query.id}: ${v1Query.probe}`, async () => {
    const params = v1Query.params as { topK: number; structuredFilters: StructuredFilter[] }
    const { results, strategy } = await runV1Query(v1Query, kbIds.hybrid)

    expect(strategy).toEqual({
      useParallel: false,
      distanceThreshold: 1.0,
      parallelLimit: params.topK + 5,
      singleQueryOptimized: true,
    })

    const top5 = freeze(results)
    recorded.queries[v1Query.id] = {
      top5,
      matchCount: results.length,
      distances: results.map((r) => Number(Number(r.distance).toFixed(6))),
      tags: results.map((r) => ({ tag1: r.tag1, tag2: r.tag2, number1: r.number1 })),
    }

    expect(results.length).toBeGreaterThan(0)
    expect(results.length).toBeLessThanOrEqual(params.topK)
    for (const row of results) {
      /** Both tag filters are ANDed; every row must satisfy both. */
      expect(row.tag1).toBe('handbook')
      expect(row.tag2).toBe('people')
      expect(row.knowledgeBaseId).toBe(kbIds.hybrid)
      expect(typeof row.content).toBe('string')
      expect(Number(row.distance)).toBeLessThan(strategy.distanceThreshold)
    }
    /** Ordered by ascending cosine distance. */
    for (let i = 1; i < results.length; i++) {
      expect(Number(results[i - 1].distance)).toBeLessThanOrEqual(Number(results[i].distance))
    }

    if (v1Query.expectedTop5.length > 0) {
      expect(top5).toEqual(v1Query.expectedTop5)
    }
  }, 60_000)

  it('the BullMQ worker path ranks identically to the inline fallback', async () => {
    const hybridQueries = fixture.queries.filter((q) => q.knowledgeBase === 'hybrid')
    expect(hybridQueries.length).toBeGreaterThan(0)

    const parity: Record<string, FrozenMatch[]> = {}
    for (const query of hybridQueries) {
      const inline =
        query.api === 'handleTagAndVectorSearch'
          ? freeze((await runV1Query(query, kbIds.hybrid)).results)
          : freeze((await runV2Query(query, kbIds.hybrid)).matches)
      const worker =
        query.api === 'handleTagAndVectorSearch'
          ? freeze((await runV1Query(query, kbIds.bullmq)).results)
          : freeze((await runV2Query(query, kbIds.bullmq)).matches)

      expect(worker, `${query.id} diverged between the two ingestion paths`).toEqual(inline)
      parity[query.id] = worker
    }

    recorded.bullmqParity = { ...recorded.bullmqParity, rankings: parity }

    if (fixture.expectations.bullmqParity) {
      expect(recorded.bullmqParity).toEqual(fixture.expectations.bullmqParity)
    }
  }, 180_000)
})
