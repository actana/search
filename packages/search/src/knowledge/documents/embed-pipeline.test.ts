/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  selectLimit,
  selectWhere,
  setMock,
  updateWhere,
  deleteWhere,
  insertValues,
  flowAdd,
  enqueueMock,
  resolveEndpointMock,
  processDocumentMock,
  partitionExistsMock,
  provisionMock,
} = vi.hoisted(() => ({
  selectLimit: vi.fn(),
  selectWhere: vi.fn(),
  setMock: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
  updateWhere: vi.fn(async () => undefined),
  deleteWhere: vi.fn(async () => undefined),
  insertValues: vi.fn(),
  flowAdd: vi.fn(async () => undefined),
  enqueueMock: vi.fn(async () => 'job-1'),
  resolveEndpointMock: vi.fn(),
  processDocumentMock: vi.fn(),
  partitionExistsMock: vi.fn(),
  provisionMock: vi.fn(async () => ({ tableName: 'kb_x' })),
}))

vi.mock('../../db/client.ts', () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({
        where: (...a: unknown[]) => Object.assign(selectWhere(...a), { limit: selectLimit }),
      }),
    })),
    update: vi.fn(() => ({ set: setMock })),
    delete: vi.fn(() => ({ where: deleteWhere })),
    insert: vi.fn(() => ({ values: insertValues })),
    transaction: vi.fn(),
  },
}))

// lifted: Studio mocked `@actana/queue` and `@/lib/core/async-jobs/config`
// separately. Both are `queue/index.ts` here, so the two factories are one —
// a second `vi.mock` of the same path would silently replace the first.
vi.mock('../../queue/index.ts', () => ({
  getFlowProducer: () => ({ add: flowAdd }),
  QUEUE_NAMES: { knowledge: 'knowledge' },
  getJobQueue: async () => ({ enqueue: enqueueMock }),
}))

vi.mock('@actana/search-shared/short-id', () => ({ generateId: () => 'gen-id' }))
vi.mock('../../kb/clustering.ts', () => ({ assignCluster: () => null }))
vi.mock('../../kb/ddl.ts', () => ({ provisionKbPartition: provisionMock }))
vi.mock('../../kb/partition.ts', () => ({
  kbPartitionRef: () => '"search"."kb_part"',
  partitionExists: partitionExistsMock,
}))
vi.mock('../../kb/provider-context.ts', () => ({ resolveKbEmbeddingEndpoint: resolveEndpointMock }))
vi.mock('./document-processor.ts', () => ({
  processDocument: processDocumentMock,
}))
vi.mock('../../models/embedding.ts', () => ({ executeWorkspaceEmbedding: vi.fn() }))

import {
  assignEndpoints,
  computeBatchRanges,
  finalizeDocumentEmbedding,
  planDocumentEmbedding,
} from './embed-pipeline.ts'

/** Make a `.values()` result that supports both bare await and `.onConflictDoUpdate()`. */
function valuesResult() {
  const p: Promise<undefined> & { onConflictDoUpdate?: () => Promise<undefined> } =
    Promise.resolve(undefined)
  p.onConflictDoUpdate = async () => undefined
  return p
}

describe('computeBatchRanges', () => {
  it('returns no ranges for an empty document', () => {
    expect(computeBatchRanges(0, 256)).toEqual([])
  })

  it('splits into contiguous half-open ranges', () => {
    expect(computeBatchRanges(5, 2)).toEqual([
      { startIndex: 0, endIndex: 2 },
      { startIndex: 2, endIndex: 4 },
      { startIndex: 4, endIndex: 5 },
    ])
  })

  it('produces a single range when everything fits', () => {
    expect(computeBatchRanges(10, 256)).toEqual([{ startIndex: 0, endIndex: 10 }])
  })
})

describe('assignEndpoints', () => {
  it('routes every range to the single endpoint', () => {
    expect(assignEndpoints(3, ['e1'])).toEqual(['e1', 'e1', 'e1'])
  })

  it('round-robins across multiple endpoints', () => {
    expect(assignEndpoints(5, ['a', 'b'])).toEqual(['a', 'b', 'a', 'b', 'a'])
  })

  it('falls back to an empty id when no endpoints are given', () => {
    expect(assignEndpoints(2, [])).toEqual(['', ''])
  })
})

describe('finalizeDocumentEmbedding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setMock.mockReturnValue({ where: updateWhere })
  })

  it('hands off to keywording and enqueues extraction when all chunks embedded', async () => {
    selectWhere.mockResolvedValueOnce([{ c: 0 }])
    await finalizeDocumentEmbedding({ knowledgeBaseId: 'kb', documentId: 'doc', filename: 'f.md' })

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ processingStatus: 'keywording', includedInKb: true })
    )
    expect(enqueueMock).toHaveBeenCalledWith('kb-keywords-extract', {
      documentId: 'doc',
      knowledgeBaseId: 'kb',
    })
  })

  it('fails the document when chunks remain unembedded after batches settle', async () => {
    selectWhere.mockResolvedValueOnce([{ c: 4 }]) // remaining null vectors
    selectWhere.mockResolvedValueOnce([{ id: 'b1', error: 'boom' }]) // failed batches
    await finalizeDocumentEmbedding({ knowledgeBaseId: 'kb', documentId: 'doc', filename: 'f.md' })

    expect(enqueueMock).not.toHaveBeenCalled()
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ processingStatus: 'failed', includedInKb: false })
    )
  })
})

describe('planDocumentEmbedding fan-out', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setMock.mockReturnValue({ where: updateWhere })
    selectWhere.mockReturnValue(Promise.resolve([]))
    insertValues.mockImplementation(valuesResult)
    resolveEndpointMock.mockResolvedValue({ dimensions: 3, modelName: 'm' })
    partitionExistsMock.mockResolvedValue(false)
  })

  it('stages chunks, provisions once, and fans out one finalize parent over N batch children', async () => {
    // kb row, then doc-tags row
    selectLimit
      .mockResolvedValueOnce([
        { userId: 'u', workspaceId: 'w', chunkingConfig: null, embeddingEndpointId: 'e1' },
      ])
      .mockResolvedValueOnce([{}])

    const chunks = Array.from({ length: 300 }, (_, i) => ({
      text: `chunk ${i}`,
      metadata: { startIndex: i, endIndex: i + 1 },
    }))
    processDocumentMock.mockResolvedValue({
      chunks,
      metadata: { chunkCount: 300, tokenCount: 600, characterCount: 2400 },
    })

    await planDocumentEmbedding({
      knowledgeBaseId: 'kb',
      documentId: 'doc',
      docData: {
        filename: 'f.md',
        fileUrl: 'http://x/f.md',
        fileSize: 2400,
        mimeType: 'text/markdown',
      },
      processingOptions: {},
      requestId: 'req',
    } as never)

    expect(provisionMock).toHaveBeenCalledTimes(1)
    expect(flowAdd).toHaveBeenCalledTimes(1)
    // lifted: the index — see the note in `kb/jobs/keywords-extract.test.ts`.
    const flow = (flowAdd.mock.calls as unknown as Array<Array<unknown>>)[0][0] as {
      name: string
      children: unknown[]
    }
    expect(flow.name).toBe('kb.embed.finalize')
    // 300 chunks / 256 per batch = 2 children
    expect(flow.children).toHaveLength(2)
  })
})
