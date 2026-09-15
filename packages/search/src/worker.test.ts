/**
 * The worker's wiring and its failure decision (ADR 0010).
 *
 * Two questions, and nothing else belongs here:
 *
 *   1. **Does every job name reach the right handler?** A routing table is the
 *      one part of a worker that fails silently — a renamed job is not a crash,
 *      it is a queue that grows — so each name is asserted, and so is the
 *      refusal of one this build does not know.
 *   2. **Does a failure retry or fail the document?** This is the whole of
 *      ADR 0010. A resolver that is briefly away must retry; a client that has
 *      forgotten an endpoint must not retry forever; an exhausted job must
 *      leave the document `failed` and say so once.
 *
 * BullMQ is mocked out entirely: there is no Redis here. The integration half —
 * a real queue, a real Postgres, a `kb.ingest.document` job processed end to
 * end — is `worker.integration.test.ts`.
 *
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UnrecoverableError, type Job } from 'bullmq'
import type { SearchEvent } from '@actana/search/contracts'

const handlers = vi.hoisted(() => ({
  publishSearchEvent: vi.fn(async () => {}),
  // Two arguments, because the dispatch table hands a budget's `AbortSignal`
  // to the two handlers that accept one, and that is asserted below.
  planDocumentEmbedding: vi.fn(async (_payload: unknown, _signal?: AbortSignal) => 'planned'),
  processEmbedBatch: vi.fn(async (_payload: unknown, _signal?: AbortSignal) => 'batched'),
  finalizeDocumentEmbedding: vi.fn(async () => 'finalized'),
  handleKeywordsExtract: vi.fn(async () => 'keyworded'),
  handleClustersValidate: vi.fn(async () => 'clustered'),
  runDocumentTimeoutSweep: vi.fn(async () => ({
    candidates: 0,
    reconciled: 0,
    failedDocumentIds: [] as string[],
  })),
  prepareIngestDocument: vi.fn(async () => ({ skip: false })),
  ingestDocument: vi.fn(async () => ({ documentId: 'doc-new', chunkCount: 3 })),
  update: vi.fn(),
  select: vi.fn(),
}))

// No Redis, no worker instance: the unit under test is the processor and the
// failure handler, both of which are plain functions.
vi.mock('bullmq', () => ({
  Job: class {},
  // The real one is what BullMQ checks to decide not to retry
  // (`classes/job.js`: `err instanceof UnrecoverableError || err.name ==
  // 'UnrecoverableError'`). The stand-in keeps the name for the same reason.
  UnrecoverableError: class UnrecoverableError extends Error {
    constructor(message?: string) {
      super(message)
      this.name = 'UnrecoverableError'
    }
  },
  Worker: class {
    on() {
      return this
    }
    async close() {}
  },
  Queue: class {
    async add() {}
    async close() {}
  },
  FlowProducer: class {
    async add() {}
    async close() {}
  },
}))
vi.mock('./queue/redis.ts', () => ({
  getQueueConnection: () => ({}),
  getRedisClient: () => ({}),
  resetQueueConnection: async () => {},
}))
vi.mock('./db/client.ts', () => ({
  db: { update: handlers.update, select: handlers.select },
}))
vi.mock('./knowledge/documents/embed-pipeline.ts', () => ({
  planDocumentEmbedding: handlers.planDocumentEmbedding,
  processEmbedBatch: handlers.processEmbedBatch,
  finalizeDocumentEmbedding: handlers.finalizeDocumentEmbedding,
}))
vi.mock('./kb/jobs/keywords-extract.ts', () => ({
  handleKeywordsExtract: handlers.handleKeywordsExtract,
}))
vi.mock('./kb/jobs/clusters-validate.ts', () => ({
  handleClustersValidate: handlers.handleClustersValidate,
  clustersValidateJobName: 'kb.clusters.validate',
}))
vi.mock('./kb/jobs/document-timeout-sweep.ts', () => ({
  runDocumentTimeoutSweep: handlers.runDocumentTimeoutSweep,
}))
vi.mock('./kb/ingest.ts', () => ({ ingestDocument: handlers.ingestDocument }))
/**
 * The ingest job's idempotency step, mocked.
 *
 * It reads a document row and deletes from a KB's *partition* — a hashed table
 * name and a transaction, neither of which a fake `db` of two methods can
 * answer. What it does is asserted for real against Postgres in
 * `worker.integration.test.ts`; what is asserted here is that the dispatch
 * consults it and honours a `skip`.
 */
vi.mock('./jobs/ingest-idempotency.ts', () => ({
  prepareIngestDocument: handlers.prepareIngestDocument,
}))
/**
 * The publish seam, not the emitter under it.
 *
 * `events/publish.ts` is the one door an event leaves through — the SSE
 * fan-out and the webhook ledger are both behind it — so mocking it is what
 * makes "who was told, and what" a single assertion. `searchEventId` is the
 * real one: the id is derived from the facts and both announcement paths have
 * to agree on it (ADR 0009 D8a).
 */
vi.mock('./events/publish.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('./events/publish.ts')>()
  return { ...real, publishSearchEvent: handlers.publishSearchEvent }
})

import { EndpointKeyUnavailableError } from './models/endpoint-key-errors.ts'
import { resetAnnouncedEvents } from './jobs/run.ts'
import {
  drainAndClose,
  handleJobFailure,
  isTerminalJobFailure,
  NotRunnableJobError,
  processSearchJob,
  type SearchWorkers,
} from './worker.ts'

/** A BullMQ job, as much of one as the code under test reads. */
function job(
  name: string,
  payload: unknown = {},
  opts: { attempts?: number; attemptsMade?: number } = {}
): Job {
  return {
    id: `job-${name}`,
    name,
    data: { type: name, payload, metadata: { correlation: { requestId: 'req-1' } } },
    attemptsMade: opts.attemptsMade ?? 0,
    opts: { attempts: opts.attempts ?? 3 },
  } as unknown as Job
}

/** Queue what `db.update(...).set(...).where(...).returning()` resolves to. */
function queueUpdate(returning: unknown[]) {
  handlers.update.mockReturnValueOnce({
    set: () => ({ where: () => ({ returning: () => Promise.resolve(returning) }) }),
  })
}

/** Queue what `db.select(...).from(...).where(...).limit()` resolves to. */
function queueSelect(rows: unknown[]) {
  handlers.select.mockReturnValueOnce({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
  })
}

/** Every event the worker published, as `(pairedClientId, event)`. */
function published(): Array<[string, SearchEvent]> {
  return handlers.publishSearchEvent.mock.calls as unknown as Array<[string, SearchEvent]>
}

/** Just the events, which is what most assertions are about. */
function publishedEvents(): SearchEvent[] {
  return published().map(([, event]) => event)
}

beforeEach(() => {
  vi.clearAllMocks()
  /**
   * `clearAllMocks` forgets the *calls*; it does not forget a queued
   * `mockReturnValueOnce`. The two database fakes are queued per test — one
   * answer per `select`, in order — so a test that queues an answer it does not
   * reach would hand it to the next test and be diagnosed there.
   */
  handlers.select.mockReset()
  handlers.update.mockReset()
  handlers.prepareIngestDocument.mockReset()
  handlers.prepareIngestDocument.mockResolvedValue({ skip: false })
  // Event ids are derived from the facts, so two tests about the same document
  // would otherwise be one announcement and one silent no-op.
  resetAnnouncedEvents()
})

describe('routing', () => {
  /**
   * The table itself is `jobs/run.ts`'s, and these go through the processor
   * because that is the path a job actually takes: what is being asserted is
   * that the worker hands every name over rather than knowing any of them.
   */
  it('sends knowledge-process-document to the planner', async () => {
    await processSearchJob(job('knowledge-process-document', { docData: { fileSize: 1024 } }))
    expect(handlers.planDocumentEmbedding).toHaveBeenCalledOnce()
    // With the size-scaled budget's signal, which used to be the worker's own
    // `withTimeout` and is now the dispatch table's.
    expect(handlers.planDocumentEmbedding.mock.calls[0]![1]).toBeInstanceOf(AbortSignal)
  })

  it('sends kb.embed.batch to the resumable range handler', async () => {
    await processSearchJob(job('kb.embed.batch', { batchId: 'b-1' }))
    expect(handlers.processEmbedBatch).toHaveBeenCalledOnce()
    expect(handlers.processEmbedBatch.mock.calls[0]![1]).toBeInstanceOf(AbortSignal)
  })

  it('sends kb.embed.finalize to the fan-in handler', async () => {
    // The name the flow producer actually uses. It was mistyped
    // `kb.document.finalize` in the JobType union, and a worker routing on
    // that would silently never finalize a document. Both spellings are in the
    // table, because both are already sitting in Redis.
    await processSearchJob(job('kb.embed.finalize', { documentId: 'd-1' }))
    await processSearchJob(job('kb.document.finalize', { documentId: 'd-2' }))
    expect(handlers.finalizeDocumentEmbedding).toHaveBeenCalledTimes(2)
  })

  it('sends kb-keywords-extract and kb.clusters.validate to theirs', async () => {
    await processSearchJob(job('kb-keywords-extract', { documentId: 'd-1' }))
    await processSearchJob(job('kb.clusters.validate', { kbId: 'kb-1' }))
    expect(handlers.handleKeywordsExtract).toHaveBeenCalledOnce()
    expect(handlers.handleClustersValidate).toHaveBeenCalledWith({ kbId: 'kb-1' }, undefined)
  })

  it('runs the stranded-document sweep', async () => {
    await processSearchJob(job('kb.document.timeout-sweep'))
    expect(handlers.runDocumentTimeoutSweep).toHaveBeenCalledOnce()
  })

  it('refuses a job name this build does not know', async () => {
    await expect(processSearchJob(job('kb.something.new'))).rejects.toThrow(
      /Unknown search job name/
    )
  })
})

describe('kb.ingest.document', () => {
  /** The row `announce()` reads back after the handler returned. */
  function queueDocument(overrides: Record<string, unknown> = {}) {
    queueSelect([
      {
        id: 'doc-new',
        knowledgeBaseId: 'kb-1',
        filename: 'handbook.md',
        chunkCount: 3,
        processingStatus: 'completed',
        processingError: null,
        processingStartedAt: new Date('2026-09-15T10:00:00Z'),
        processingCompletedAt: new Date('2026-09-15T10:00:30Z'),
        ...overrides,
      },
    ])
    queueSelect([{ pairedClientId: 'pc-1', kmeansUpdatedAt: null }])
  }

  it('ingests text and announces the document', async () => {
    queueDocument()

    const result = await processSearchJob(
      job('kb.ingest.document', {
        kbId: 'kb-1',
        documentId: 'doc-new',
        filename: 'handbook.md',
        text: '# Handbook',
        tags: { tag_1: 'people' },
      })
    )

    expect(result).toEqual({ documentId: 'doc-new', chunkCount: 3 })
    /**
     * The payload goes to the frozen `ingestDocument` as it stands — including
     * `documentId` and `tags`, which is what makes a retry resume the row the
     * route staged instead of inserting another one.
     */
    expect(handlers.ingestDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        kbId: 'kb-1',
        documentId: 'doc-new',
        filename: 'handbook.md',
        tags: { tag_1: 'people' },
      }),
      // The ingest job has a size-scaled budget now, so it is handed the
      // signal the other long jobs are handed (`jobs/run.ts`).
      expect.any(AbortSignal)
    )
    expect(published()).toEqual([
      [
        'pc-1',
        expect.objectContaining({
          event: 'document.ingested',
          kbId: 'kb-1',
          documentId: 'doc-new',
          chunkCount: 3,
        }),
      ],
    ])
  })

  it('asks the idempotency step first, and does not re-ingest a completed document', async () => {
    /**
     * `kb/ingest.ts` has no `completed` short-circuit and no
     * delete-before-insert, and the partition has no `(document_id,
     * chunk_index)` uniqueness — so a second run of one job is a second copy of
     * every chunk. The job layer is what stops that (`jobs/ingest-idempotency.ts`,
     * asserted against a real partition in the integration suite); what is
     * asserted here is that the dispatch honours it.
     */
    handlers.prepareIngestDocument.mockResolvedValueOnce({ skip: true })
    queueDocument()

    const result = await processSearchJob(
      job('kb.ingest.document', {
        kbId: 'kb-1',
        documentId: 'doc-new',
        filename: 'handbook.md',
        text: '# Handbook',
      })
    )

    expect(result).toBeUndefined()
    expect(handlers.prepareIngestDocument).toHaveBeenCalledOnce()
    expect(handlers.ingestDocument).not.toHaveBeenCalled()
  })

  it('refuses a payload with no knowledge base, and one with no text', async () => {
    await expect(
      processSearchJob(job('kb.ingest.document', { filename: 'x.md', text: 'hi' }))
    ).rejects.toThrow(/kbId and filename are required/)
    await expect(
      processSearchJob(job('kb.ingest.document', { kbId: 'kb-1', filename: 'x.md' }))
    ).rejects.toThrow(/text is required/)
    expect(handlers.ingestDocument).not.toHaveBeenCalled()
  })
})

describe('a document that is failed but not finished', () => {
  /**
   * The post-merge behaviour this rebase had to decide.
   *
   * TASK-004 announces from the job's completion, reading the row the engine
   * wrote — and the engine writes `failed` as soon as *this attempt* gave up,
   * which on attempt one of five is a resolver that was away for a second. A
   * `document.failed` on the wire is a thing Studio's trigger acts on, so it is
   * held back until the attempt that really is the last one.
   */
  const payload = { kbId: 'kb-1', documentId: 'doc-7', filename: 'x.md', text: 'hi' }

  function queueFailedRow() {
    queueSelect([
      {
        id: 'doc-7',
        knowledgeBaseId: 'kb-1',
        filename: 'x.md',
        chunkCount: 0,
        processingStatus: 'failed',
        processingError: 'the resolver was not answering',
        processingStartedAt: new Date('2026-09-15T10:00:00Z'),
        processingCompletedAt: new Date('2026-09-15T10:00:30Z'),
      },
    ])
    queueSelect([{ pairedClientId: 'pc-1', kmeansUpdatedAt: null }])
  }

  it('says nothing while BullMQ still has attempts for the job', async () => {
    queueFailedRow()
    handlers.ingestDocument.mockRejectedValueOnce(new Error('the resolver was not answering'))

    await expect(
      processSearchJob(job('kb.ingest.document', payload, { attempts: 5, attemptsMade: 0 }))
    ).rejects.toThrow(/not answering/)

    expect(published()).toEqual([])
  })

  it('announces it on the attempt that is the last one', async () => {
    queueFailedRow()
    handlers.ingestDocument.mockRejectedValueOnce(new Error('the resolver was not answering'))

    await expect(
      processSearchJob(job('kb.ingest.document', payload, { attempts: 5, attemptsMade: 4 }))
    ).rejects.toThrow(/not answering/)

    expect(publishedEvents()).toEqual([
      expect.objectContaining({
        event: 'document.failed',
        documentId: 'doc-7',
        error: 'the resolver was not answering',
      }),
    ])
  })

  it('announces a success whatever the attempt number', async () => {
    // Only the failure is held back: a document that ingested on attempt two of
    // five has ingested.
    queueSelect([
      {
        id: 'doc-7',
        knowledgeBaseId: 'kb-1',
        filename: 'x.md',
        chunkCount: 2,
        processingStatus: 'completed',
        processingError: null,
        processingStartedAt: new Date('2026-09-15T10:00:00Z'),
        processingCompletedAt: new Date('2026-09-15T10:00:30Z'),
      },
    ])
    queueSelect([{ pairedClientId: 'pc-1', kmeansUpdatedAt: null }])

    await processSearchJob(job('kb.ingest.document', payload, { attempts: 5, attemptsMade: 1 }))
    expect(publishedEvents()).toEqual([
      expect.objectContaining({ event: 'document.ingested', documentId: 'doc-7' }),
    ])
  })
})

/**
 * The failure the *ordinary* path lost, and the id that made a second success
 * disappear. Both are about what an announcement is derived from.
 */
describe('a handler that returned, and what it leaves on the row', () => {
  /** A document row in a terminal state, with the stamps an event id reads. */
  function queueRow(overrides: Record<string, unknown> = {}) {
    queueSelect([
      {
        id: 'doc-9',
        knowledgeBaseId: 'kb-1',
        filename: 'handbook.md',
        chunkCount: 0,
        processingStatus: 'failed',
        processingError: 'Embedding incomplete: 12 chunk(s) unembedded',
        processingStartedAt: new Date('2026-09-15T10:00:00Z'),
        processingCompletedAt: new Date('2026-09-15T10:05:00Z'),
        ...overrides,
      },
    ])
    queueSelect([{ pairedClientId: 'pc-1', kmeansUpdatedAt: null }])
  }

  const payload = { documentId: 'doc-9', knowledgeBaseId: 'kb-1' }

  /**
   * The blocker. `finalizeDocumentEmbedding` marks a document `failed` when its
   * batches have exhausted *their* attempts and then **returns normally** — so
   * the job completes, BullMQ's `failed` handler never runs, and nothing ever
   * re-reads the row. The announcement was nonetheless held back, because
   * `attemptsRemaining` on a first attempt of three is `2` whatever the handler
   * did. Studio therefore never heard `document.failed` on the ordinary BullMQ
   * path at all; the fixture suites are green because the inline runner passes
   * `0`.
   */
  it('announces a failed row the finalizer wrote, with attempts still on the job', async () => {
    queueRow()

    await processSearchJob(job('kb.embed.finalize', payload, { attempts: 3, attemptsMade: 0 }))

    expect(handlers.finalizeDocumentEmbedding).toHaveBeenCalledOnce()
    expect(publishedEvents()).toEqual([
      expect.objectContaining({
        event: 'document.failed',
        documentId: 'doc-9',
        kbId: 'kb-1',
        error: expect.stringContaining('unembedded'),
      }),
    ])
    // Exactly one event, and not the ingested one: the row is what is read.
    expect(publishedEvents()).toHaveLength(1)
  })

  it('still holds a failed row back while the dispatch itself is retrying', async () => {
    // The distinction the fix turns on: this one threw, so the transport may
    // run it again and the `failed` row is not news yet.
    queueRow()
    handlers.finalizeDocumentEmbedding.mockRejectedValueOnce(new Error('the resolver went away'))

    await expect(
      processSearchJob(job('kb.embed.finalize', payload, { attempts: 3, attemptsMade: 0 }))
    ).rejects.toThrow(/went away/)

    expect(published()).toEqual([])
  })

  /**
   * The event id carries the generation of the processing run, so the dedupe
   * covers the attempts of one run and nothing else. Without it a re-include of
   * a completed document produced a second `document.ingested` with the *same*
   * id, which `claimAnnouncedEvent` dropped in-process and the ledger's
   * `(webhook, event)` unique index dropped for good.
   */
  it('gives the attempts of one run one event id', async () => {
    queueRow({ processingStatus: 'completed', chunkCount: 4, processingError: null })
    await processSearchJob(job('kb.embed.finalize', payload, { attempts: 3, attemptsMade: 0 }))
    // The same run, announced again — a second job visiting the same document.
    queueRow({ processingStatus: 'completed', chunkCount: 4, processingError: null })
    await processSearchJob(job('kb.document.finalize', payload, { attempts: 3, attemptsMade: 1 }))

    expect(publishedEvents()).toHaveLength(1)
  })

  it('gives a second run its own event, because it is a second event', async () => {
    queueRow({ processingStatus: 'completed', chunkCount: 4, processingError: null })
    await processSearchJob(job('kb.embed.finalize', payload, { attempts: 3, attemptsMade: 0 }))

    // `POST …/documents/:docId/include` over a document that already ingested:
    // the pipeline re-stamps `processingStartedAt`, which is the generation.
    queueRow({
      processingStatus: 'completed',
      chunkCount: 6,
      processingError: null,
      processingStartedAt: new Date('2026-09-16T08:00:00Z'),
      processingCompletedAt: new Date('2026-09-16T08:01:00Z'),
    })
    await processSearchJob(job('kb.embed.finalize', payload, { attempts: 3, attemptsMade: 0 }))

    const events = publishedEvents()
    expect(events).toHaveLength(2)
    expect(events[0]!.event).toBe('document.ingested')
    expect(events[1]!.event).toBe('document.ingested')
    expect(events[0]!.id).not.toBe(events[1]!.id)
    expect(events[1]).toMatchObject({ chunkCount: 6 })
  })
})

describe('the stranded-document sweep says what it reconciled', () => {
  /**
   * The third path to `failed`, and the one that was silent. A worker killed
   * mid-job — or a job past `maxStalledCount` — leaves the row non-terminal
   * with nothing running, so neither the ordinary announcement nor the failure
   * handler ever sees that document again. The sweep flips the row; until now
   * it told nobody.
   */
  function queueSweptDocument(id: string, overrides: Record<string, unknown> = {}) {
    queueSelect([
      {
        id,
        knowledgeBaseId: 'kb-1',
        filename: `${id}.pdf`,
        chunkCount: 0,
        processingStatus: 'failed',
        processingError: 'Processing timed out. Please retry or re-sync the connector.',
        processingStartedAt: new Date('2026-09-15T09:00:00Z'),
        processingCompletedAt: new Date('2026-09-15T09:30:00Z'),
        ...overrides,
      },
    ])
    queueSelect([{ pairedClientId: 'pc-1', kmeansUpdatedAt: null }])
  }

  it('announces document.failed, with the timeout reason, for every row it flipped', async () => {
    handlers.runDocumentTimeoutSweep.mockResolvedValueOnce({
      candidates: 2,
      reconciled: 2,
      failedDocumentIds: ['doc-a', 'doc-b'],
    })
    queueSweptDocument('doc-a')
    queueSweptDocument('doc-b')

    await processSearchJob(job('kb.document.timeout-sweep'))

    expect(publishedEvents()).toEqual([
      expect.objectContaining({
        event: 'document.failed',
        documentId: 'doc-a',
        kbId: 'kb-1',
        reason: 'timeout',
      }),
      expect.objectContaining({
        event: 'document.failed',
        documentId: 'doc-b',
        reason: 'timeout',
      }),
    ])
  })

  it('announces the state the row is in, not the one the sweep assumed', async () => {
    // `markDocumentAsFailedTimeout`'s UPDATE is narrowed to a non-terminal
    // status and still reports success, so the row — not the sweep's list — is
    // what decides. This is that check.
    handlers.runDocumentTimeoutSweep.mockResolvedValueOnce({
      candidates: 1,
      reconciled: 1,
      failedDocumentIds: ['doc-c'],
    })
    queueSweptDocument('doc-c', { processingStatus: 'completed', chunkCount: 9 })

    await processSearchJob(job('kb.document.timeout-sweep'))

    expect(publishedEvents()).toEqual([
      expect.objectContaining({ event: 'document.ingested', documentId: 'doc-c' }),
    ])
  })

  it('announces nothing when the sweep found nothing', async () => {
    await processSearchJob(job('kb.document.timeout-sweep'))
    expect(published()).toEqual([])
  })
})

describe('a failure retries or fails the document', () => {
  const target = { documentId: 'doc-7', knowledgeBaseId: 'kb-1' }

  it('retries a resolver outage without touching the document', async () => {
    const err = new EndpointKeyUnavailableError('resolver 503', {
      reason: 'resolver-error',
      endpointId: 'ep-1',
      externalId: 'ws-1',
      pairedClientId: 'pc-1',
    })

    await handleJobFailure(job('kb.embed.batch', target, { attempts: 5, attemptsMade: 1 }), err)

    expect(handlers.update).not.toHaveBeenCalled()
    expect(published()).toEqual([])
  })

  it('fails the document once the retryable failure runs out of attempts', async () => {
    const err = new EndpointKeyUnavailableError('resolver 503', { reason: 'resolver-error' })
    queueUpdate([{ id: 'doc-7' }])
    queueSelect([{ pairedClientId: 'pc-1' }])

    await handleJobFailure(job('kb.embed.batch', target, { attempts: 5, attemptsMade: 5 }), err)

    expect(handlers.update).toHaveBeenCalledOnce()
    expect(published()).toEqual([
      [
        'pc-1',
        expect.objectContaining({
          event: 'document.failed',
          documentId: 'doc-7',
          kbId: 'kb-1',
          reason: 'resolver-error',
        }),
      ],
    ])
  })

  it('finds the document under `kbId` as well as `knowledgeBaseId`', async () => {
    // `kb.ingest.document`'s payload says `kbId`, because that is what the
    // frozen `ingestDocument` destructures. Reading only the other spelling
    // left an ingest job's document in `pending` with nothing said about it.
    queueUpdate([{ id: 'doc-7' }])
    queueSelect([{ pairedClientId: 'pc-1' }])

    await handleJobFailure(
      job(
        'kb.ingest.document',
        { documentId: 'doc-7', kbId: 'kb-9' },
        { attempts: 1, attemptsMade: 1 }
      ),
      new Error('this PDF is a picture of a PDF')
    )

    expect(handlers.update).toHaveBeenCalledOnce()
    expect(publishedEvents()).toEqual([
      expect.objectContaining({ event: 'document.failed', kbId: 'kb-9', documentId: 'doc-7' }),
    ])
  })

  it('does not retry a client that has forgotten the endpoint, even on attempt one', async () => {
    // `unknown-endpoint` is terminal: the mirror is stale, and the fourth
    // attempt will be told the same thing. Poisoning the queue with it is the
    // failure ADR 0010's risk note names.
    const err = new EndpointKeyUnavailableError('gone', { reason: 'unknown-endpoint' })
    queueUpdate([{ id: 'doc-7' }])
    queueSelect([{ pairedClientId: 'pc-1' }])

    await handleJobFailure(job('kb.embed.batch', target, { attempts: 5, attemptsMade: 1 }), err)

    expect(handlers.update).toHaveBeenCalledOnce()
  })

  it('fails the document on an ordinary error with no attempts left', async () => {
    queueUpdate([{ id: 'doc-7' }])
    queueSelect([{ pairedClientId: 'pc-1' }])

    await handleJobFailure(
      job('knowledge-process-document', target, { attempts: 3, attemptsMade: 3 }),
      new Error('this PDF is a picture of a PDF')
    )

    expect(publishedEvents()[0]).toMatchObject({
      event: 'document.failed',
      error: expect.stringContaining('PDF'),
    })
    expect(publishedEvents()[0]).not.toHaveProperty('reason')
  })

  it('tells nobody when the knowledge base has no paired client left', async () => {
    // The KB was deleted under the job: there is no addressee.
    queueUpdate([{ id: 'doc-7' }])
    queueSelect([{ pairedClientId: null }])

    await handleJobFailure(
      job('kb.embed.batch', target, { attempts: 1, attemptsMade: 1 }),
      new Error('too late')
    )
    expect(published()).toEqual([])
  })

  it('emits nothing when a sibling already carried the document to completed', async () => {
    // The narrowed UPDATE matched no row, and the row is not `failed` either —
    // so this job's failure is not this document's news.
    queueUpdate([])
    queueSelect([
      {
        id: 'doc-7',
        knowledgeBaseId: 'kb-1',
        filename: 'x.md',
        chunkCount: 4,
        processingStatus: 'completed',
        processingError: null,
      },
    ])

    await handleJobFailure(
      job('kb.embed.batch', target, { attempts: 1, attemptsMade: 1 }),
      new Error('too late')
    )

    expect(published()).toEqual([])
  })

  it('still says so when the engine had already written `failed` itself', async () => {
    /**
     * The gap the two announcement paths leave between them. A *terminal*
     * failure on attempt one of five: `jobs/run.ts` held the announcement back
     * because BullMQ had attempts left, and the narrowed UPDATE here then
     * matched nothing because the engine had already marked the row. Somebody
     * has to make the announcement, and `claimAnnouncedEvent` is what stops it
     * being made twice.
     */
    queueUpdate([])
    queueSelect([
      {
        id: 'doc-7',
        knowledgeBaseId: 'kb-1',
        filename: 'x.md',
        chunkCount: 0,
        processingStatus: 'failed',
        processingError: 'the mirror is stale',
      },
    ])
    queueSelect([{ pairedClientId: 'pc-1' }])

    await handleJobFailure(
      job('kb.embed.batch', target, { attempts: 5, attemptsMade: 1 }),
      new EndpointKeyUnavailableError('the mirror is stale', { reason: 'unknown-endpoint' })
    )

    expect(publishedEvents()).toEqual([
      expect.objectContaining({
        event: 'document.failed',
        documentId: 'doc-7',
        reason: 'unknown-endpoint',
      }),
    ])
  })

  it('says nothing about a document when the payload names none', async () => {
    await handleJobFailure(
      job('kb.clusters.validate', { kbId: 'kb-1' }, { attempts: 2, attemptsMade: 2 }),
      new Error('clustering fell over')
    )
    expect(handlers.update).not.toHaveBeenCalled()
  })

  it('survives a failure with no job attached', async () => {
    await expect(handleJobFailure(undefined, new Error('orphan'))).resolves.toBeUndefined()
  })

  it('does not let a database that is also down turn into a second throw', async () => {
    handlers.update.mockReturnValueOnce({
      set: () => ({
        where: () => ({
          returning: () => Promise.reject(new Error('the database is gone too')),
        }),
      }),
    })
    await expect(
      handleJobFailure(
        job('kb.embed.batch', target, { attempts: 1, attemptsMade: 1 }),
        new Error('first failure')
      )
    ).resolves.toBeUndefined()
  })
})

describe('a terminal failure is unrecoverable, not retried', () => {
  /**
   * The gap this describe closes. `handleJobFailure` has always known that a
   * resolver answering `404 unknown-endpoint` would say the same on the fifth
   * attempt — and BullMQ, which has never heard of `retryable`, re-queued the
   * job anyway, because nothing turned the classification into the one thing it
   * reads. Every attempt then ran a full ingest to arrive at the same 404.
   */
  const ingestJob = () =>
    job('kb.ingest.document', {
      kbId: 'kb-1',
      filename: 'handbook.md',
      text: '# Handbook',
      documentId: 'doc-7',
    })

  it('re-throws a terminal key failure as UnrecoverableError, keeping the reason', async () => {
    const original = new EndpointKeyUnavailableError('the client forgot it', {
      reason: 'unknown-endpoint',
      endpointId: 'ep-1',
      externalId: 'ws-1',
      pairedClientId: 'pc-1',
    })
    handlers.ingestDocument.mockRejectedValueOnce(original)

    const err = (await processSearchJob(ingestJob())
      .then(() => null)
      .catch((e: unknown) => e)) as Error

    expect(err).toBeInstanceOf(UnrecoverableError)
    expect(err.name).toBe('UnrecoverableError')
    // The message survives, so `failedReason` still names the resolver…
    expect(err.message).toBe('the client forgot it')
    // …and the typed reason survives on the cause, which is what the log line
    // and `document.failed` read.
    expect(err.cause).toBe(original)
  })

  for (const reason of ['refused', 'decrypt-failed', 'model-mismatch', 'client-mismatch'] as const) {
    it(`treats ${reason} as terminal`, async () => {
      handlers.ingestDocument.mockRejectedValueOnce(
        new EndpointKeyUnavailableError(reason, { reason })
      )
      await expect(processSearchJob(ingestJob())).rejects.toBeInstanceOf(UnrecoverableError)
    })
  }

  it('leaves a transient key failure exactly as it was thrown', async () => {
    const original = new EndpointKeyUnavailableError('resolver 503', { reason: 'resolver-error' })
    handlers.ingestDocument.mockRejectedValueOnce(original)
    const err = await processSearchJob(ingestJob())
      .then(() => null)
      .catch((e: unknown) => e)
    expect(err).toBe(original)
    expect(err).not.toBeInstanceOf(UnrecoverableError)
  })

  it('leaves an ordinary error alone — a parse may well work on a retry', async () => {
    const original = new Error('this PDF is a picture of a PDF')
    handlers.ingestDocument.mockRejectedValueOnce(original)
    await expect(processSearchJob(ingestJob())).rejects.toBe(original)
  })

  it('makes a job name this build does not know unrecoverable', async () => {
    const err = (await processSearchJob(job('kb.something.new'))
      .then(() => null)
      .catch((e: unknown) => e)) as Error
    expect(err).toBeInstanceOf(UnrecoverableError)
    expect(err.cause).toBeInstanceOf(NotRunnableJobError)
    expect(err.message).toMatch(/Unknown search job name/)
  })

  it('makes a payload that is missing its knowledge base unrecoverable', async () => {
    const err = (await processSearchJob(job('kb.ingest.document', { filename: 'x.md' }))
      .then(() => null)
      .catch((e: unknown) => e)) as Error
    expect(err).toBeInstanceOf(UnrecoverableError)
    expect(err.message).toMatch(/kbId and filename are required/)
  })

  it('classifies through the wrapper as well as the raw error', () => {
    const terminal = new EndpointKeyUnavailableError('gone', { reason: 'unknown-endpoint' })
    const wrapped = new UnrecoverableError('gone')
    wrapped.cause = terminal
    expect(isTerminalJobFailure(terminal)).toBe(true)
    expect(isTerminalJobFailure(wrapped)).toBe(true)
    expect(isTerminalJobFailure(new NotRunnableJobError('nope'))).toBe(true)
    expect(
      isTerminalJobFailure(new EndpointKeyUnavailableError('503', { reason: 'resolver-error' }))
    ).toBe(false)
    expect(isTerminalJobFailure(new Error('weather'))).toBe(false)
  })

  it('still fails the document once, with the reason, when the failure is wrapped', async () => {
    const target = { documentId: 'doc-7', knowledgeBaseId: 'kb-1' }
    const terminal = new EndpointKeyUnavailableError('the mirror is stale', {
      reason: 'unknown-endpoint',
      endpointId: 'ep-1',
    })
    const wrapped = new UnrecoverableError(terminal.message)
    wrapped.cause = terminal
    queueUpdate([{ id: 'doc-7' }])
    queueSelect([{ pairedClientId: 'pc-1' }])

    // Attempt one of five: BullMQ will not give it a second, and neither does
    // this.
    await handleJobFailure(
      job('kb.ingest.document', target, { attempts: 5, attemptsMade: 1 }),
      wrapped
    )

    expect(handlers.update).toHaveBeenCalledOnce()
    expect(publishedEvents()).toEqual([
      expect.objectContaining({
        event: 'document.failed',
        documentId: 'doc-7',
        reason: 'unknown-endpoint',
      }),
    ])
  })
})

describe('shutdown', () => {
  /** A `SearchWorkers` that only records that it was drained. */
  const fakeWorkers = (order: string[], fail = false): SearchWorkers => ({
    workers: [],
    close: async () => {
      order.push('workers')
      if (fail) throw new Error('the worker would not stop')
    },
  })

  it('drains the worker first, then closes the listeners in the order given', async () => {
    // The order is the decision: a job in flight still needs the database and
    // the queue, so a listener closed underneath it would turn a clean handover
    // into the half-written document the drain exists to avoid.
    const order: string[] = []
    await drainAndClose(fakeWorkers(order), [
      { name: 'api', close: async () => void order.push('api') },
      { name: 'admin', close: async () => void order.push('admin') },
    ])
    expect(order).toEqual(['workers', 'api', 'admin'])
  })

  it('closes the listeners when the workers are somewhere else', async () => {
    // `SEARCH_WORKERS=off`: there was no shutdown handler at all before, so a
    // SIGTERM left the API listener and the admin socket to the kill.
    const order: string[] = []
    await drainAndClose(null, [
      { name: 'api', close: async () => void order.push('api') },
      { name: 'admin', close: async () => void order.push('admin') },
    ])
    expect(order).toEqual(['api', 'admin'])
  })

  it('closes what it can when a worker or a listener will not stop', async () => {
    const order: string[] = []
    await expect(
      drainAndClose(fakeWorkers(order, true), [
        {
          name: 'api',
          close: async () => {
            order.push('api')
            throw new Error('a request would not finish')
          },
        },
        { name: 'admin', close: async () => void order.push('admin') },
      ])
    ).resolves.toBeUndefined()
    // The admin socket is still unlinked: one listener that will not shut down
    // must not leave the next one open.
    expect(order).toEqual(['workers', 'api', 'admin'])
  })
})
