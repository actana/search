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

const handlers = vi.hoisted(() => ({
  planDocumentEmbedding: vi.fn(async () => 'planned'),
  processEmbedBatch: vi.fn(async () => 'batched'),
  finalizeDocumentEmbedding: vi.fn(async () => 'finalized'),
  handleKeywordsExtract: vi.fn(async () => 'keyworded'),
  handleClustersValidate: vi.fn(async () => 'clustered'),
  runDocumentTimeoutSweep: vi.fn(async () => ({ candidates: 0, reconciled: 0 })),
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

import { clearSearchEventListeners, onSearchEvent, type SearchEvent } from './events.ts'
import { EndpointKeyUnavailableError } from './models/endpoint-key-errors.ts'
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

beforeEach(() => {
  vi.clearAllMocks()
  clearSearchEventListeners()
})

describe('routing', () => {
  it('sends knowledge-process-document to the planner', async () => {
    await processSearchJob(job('knowledge-process-document', { docData: { fileSize: 1024 } }))
    expect(handlers.planDocumentEmbedding).toHaveBeenCalledOnce()
  })

  it('sends kb.embed.batch to the resumable range handler', async () => {
    await processSearchJob(job('kb.embed.batch', { batchId: 'b-1' }))
    expect(handlers.processEmbedBatch).toHaveBeenCalledOnce()
  })

  it('sends kb.embed.finalize to the fan-in handler', async () => {
    // The name the flow producer actually uses. It was mistyped
    // `kb.document.finalize` in the JobType union, and a worker routing on
    // that would silently never finalize a document.
    await processSearchJob(job('kb.embed.finalize', { documentId: 'd-1' }))
    expect(handlers.finalizeDocumentEmbedding).toHaveBeenCalledOnce()
  })

  it('sends kb-keywords-extract and kb.clusters.validate to theirs', async () => {
    await processSearchJob(job('kb-keywords-extract', { documentId: 'd-1' }))
    await processSearchJob(job('kb.clusters.validate', { kbId: 'kb-1' }))
    expect(handlers.handleKeywordsExtract).toHaveBeenCalledOnce()
    expect(handlers.handleClustersValidate).toHaveBeenCalledWith({ kbId: 'kb-1' })
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
  it('ingests text and announces the document', async () => {
    const seen: SearchEvent[] = []
    onSearchEvent((e) => seen.push(e))
    queueSelect([{ pairedClientId: 'pc-1' }])

    const result = await processSearchJob(
      job('kb.ingest.document', {
        knowledgeBaseId: 'kb-1',
        filename: 'handbook.md',
        text: '# Handbook',
      })
    )

    expect(result).toEqual({ documentId: 'doc-new', chunkCount: 3 })
    expect(handlers.ingestDocument).toHaveBeenCalledWith(
      expect.objectContaining({ kbId: 'kb-1', filename: 'handbook.md', includedInKb: true })
    )
    expect(seen).toEqual([
      expect.objectContaining({
        type: 'document.ingested',
        knowledgeBaseId: 'kb-1',
        documentId: 'doc-new',
        chunkCount: 3,
        pairedClientId: 'pc-1',
      }),
    ])
  })

  it('refuses a payload with neither text nor a file url', async () => {
    await expect(
      processSearchJob(job('kb.ingest.document', { knowledgeBaseId: 'kb-1', filename: 'x.md' }))
    ).rejects.toThrow(/one of text or fileUrl/)
    expect(handlers.ingestDocument).not.toHaveBeenCalled()
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
    const seen: SearchEvent[] = []
    onSearchEvent((e) => seen.push(e))

    await handleJobFailure(job('kb.embed.batch', target, { attempts: 5, attemptsMade: 1 }), err)

    expect(handlers.update).not.toHaveBeenCalled()
    expect(seen).toEqual([])
  })

  it('fails the document once the retryable failure runs out of attempts', async () => {
    const err = new EndpointKeyUnavailableError('resolver 503', { reason: 'resolver-error' })
    const seen: SearchEvent[] = []
    onSearchEvent((e) => seen.push(e))
    queueUpdate([{ id: 'doc-7' }])
    queueSelect([{ pairedClientId: 'pc-1' }])

    await handleJobFailure(job('kb.embed.batch', target, { attempts: 5, attemptsMade: 5 }), err)

    expect(handlers.update).toHaveBeenCalledOnce()
    expect(seen).toEqual([
      expect.objectContaining({
        type: 'document.failed',
        documentId: 'doc-7',
        knowledgeBaseId: 'kb-1',
        reason: 'resolver-error',
      }),
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
    const seen: SearchEvent[] = []
    onSearchEvent((e) => seen.push(e))
    queueUpdate([{ id: 'doc-7' }])
    queueSelect([{ pairedClientId: null }])

    await handleJobFailure(
      job('knowledge-process-document', target, { attempts: 3, attemptsMade: 3 }),
      new Error('this PDF is a picture of a PDF')
    )

    expect(seen[0]).toMatchObject({ type: 'document.failed', error: expect.stringContaining('PDF') })
    expect(seen[0]).not.toHaveProperty('reason')
  })

  it('emits nothing when the document was already terminal', async () => {
    const seen: SearchEvent[] = []
    onSearchEvent((e) => seen.push(e))
    // The narrowed UPDATE matched no row: a sibling already settled it.
    queueUpdate([])

    await handleJobFailure(
      job('kb.embed.batch', target, { attempts: 1, attemptsMade: 1 }),
      new Error('too late')
    )

    expect(seen).toEqual([])
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
      knowledgeBaseId: 'kb-1',
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
    expect(err.message).toMatch(/knowledgeBaseId and filename are required/)
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
    const seen: SearchEvent[] = []
    onSearchEvent((e) => seen.push(e))
    queueUpdate([{ id: 'doc-7' }])
    queueSelect([{ pairedClientId: 'pc-1' }])

    // Attempt one of five: BullMQ will not give it a second, and neither does
    // this.
    await handleJobFailure(
      job('kb.ingest.document', target, { attempts: 5, attemptsMade: 1 }),
      wrapped
    )

    expect(handlers.update).toHaveBeenCalledOnce()
    expect(seen).toEqual([
      expect.objectContaining({
        type: 'document.failed',
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
