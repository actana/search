/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { selectResult, setSpy, extractMock, drainMock, recomputeMock, resolveInferenceMock } =
  vi.hoisted(() => ({
    selectResult: vi.fn(),
    setSpy: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    extractMock: vi.fn(),
    drainMock: vi.fn(async () => undefined),
    recomputeMock: vi.fn(async () => undefined),
    resolveInferenceMock: vi.fn(async () => ({ id: 'inf', modelName: 'm' })),
  }))

vi.mock('../../db/client.ts', () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({ limit: selectResult, orderBy: selectResult }),
      }),
    })),
    update: vi.fn(() => ({ set: setSpy })),
  },
}))

vi.mock('../clustering-trigger.ts', () => ({ maybeEnqueueClusteringIfDrained: drainMock }))
vi.mock('../provider-context.ts', () => ({ resolveKbInferenceEndpoint: resolveInferenceMock }))
vi.mock('../keywords/index.ts', () => ({
  attachKeywordToChunk: vi.fn(async () => undefined),
  extractKeywordsForChunk: extractMock,
  KB_KEYWORDS_EXTRACT_JOB_NAME: 'kb-keywords-extract',
  KeywordInferenceFatalError: class KeywordInferenceFatalError extends Error {},
  listKbKeywords: vi.fn(async () => []),
  recomputeDocumentKeywords: recomputeMock,
  upsertKbKeyword: vi.fn(async () => ({ id: 'kw-1', keyword: 'k' })),
}))

import { handleKeywordsExtract } from './keywords-extract.ts'

/** Find the `keyword_status` value written via `setDocumentStatus`. */
function keywordStatusWrites(): string[] {
  // lifted: `c[0]` — vitest 4 types an untyped `vi.fn()`'s call tuple as `[]`,
  // where vitest 3 left it loose. Spread to index it.
  return (setSpy.mock.calls as unknown as Array<Array<{ keywordStatus?: string }>>)
    .map((c) => c[0]?.keywordStatus)
    .filter((v): v is string => typeof v === 'string')
}

function primeDoc(chunkCount: number) {
  const chunks = Array.from({ length: chunkCount }, (_, i) => ({
    id: `c${i}`,
    chunkIndex: i,
    content: `chunk ${i}`,
  }))
  selectResult
    .mockResolvedValueOnce([{ id: 'doc', filename: 'f.md', knowledgeBaseId: 'kb' }]) // document
    .mockResolvedValueOnce([{ id: 'kb', inferenceEndpointId: 'inf', workspaceId: 'w' }]) // kb
    .mockResolvedValueOnce(chunks) // enabled chunks
}

describe('handleKeywordsExtract consecutive-failure rule', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setSpy.mockReturnValue({ where: vi.fn(async () => undefined) })
  })

  it('fails the document after 3 consecutive hard errors', async () => {
    primeDoc(5)
    extractMock
      .mockRejectedValueOnce(new Error('401'))
      .mockRejectedValueOnce(new Error('401'))
      .mockRejectedValueOnce(new Error('401'))
      .mockResolvedValue([{ canonical: 'x', display: 'X' }])

    await handleKeywordsExtract({ documentId: 'doc', knowledgeBaseId: 'kb' })

    // aborted after 3 consecutive → only 3 inference calls, status failed
    expect(extractMock).toHaveBeenCalledTimes(3)
    expect(keywordStatusWrites()).toContain('failed')
    expect(keywordStatusWrites()).not.toContain('extracted')
    expect(drainMock).toHaveBeenCalled()
  })

  it('treats empty model results as acceptable (extracted, not failed)', async () => {
    primeDoc(3)
    extractMock.mockResolvedValue([]) // every chunk returns no keywords

    await handleKeywordsExtract({ documentId: 'doc', knowledgeBaseId: 'kb' })

    expect(extractMock).toHaveBeenCalledTimes(3)
    expect(keywordStatusWrites()).toContain('extracted')
    expect(keywordStatusWrites()).not.toContain('failed')
  })

  it('does not fail when failures never reach 3 in a row (a success resets the streak)', async () => {
    primeDoc(5)
    extractMock
      .mockRejectedValueOnce(new Error('blip'))
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValueOnce([{ canonical: 'x', display: 'X' }]) // resets streak
      .mockRejectedValueOnce(new Error('blip'))
      .mockRejectedValueOnce(new Error('blip'))

    await handleKeywordsExtract({ documentId: 'doc', knowledgeBaseId: 'kb' })

    expect(extractMock).toHaveBeenCalledTimes(5)
    expect(keywordStatusWrites()).toContain('extracted')
    expect(keywordStatusWrites()).not.toContain('failed')
    expect(recomputeMock).toHaveBeenCalled()
  })
})
