/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockExecute, mockResolveEndpoint } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockResolveEndpoint: vi.fn(),
}))

vi.mock('../../models/inference.ts', () => ({
  executeWorkspaceInference: mockExecute,
}))

vi.mock('../provider-context.ts', () => ({
  resolveKbInferenceEndpoint: mockResolveEndpoint,
}))

import { extractKeywordsForChunk, KeywordInferenceFatalError } from './extract.ts'
import { buildKeywordExtractionPrompt } from './prompts/keyword-extraction.ts'

const FAKE_ENDPOINT = {
  id: 'ep-1',
  workspaceId: 'ws-1',
  providerId: 'openai-compatible',
  template: 'openai',
  kind: 'inference',
  modelName: 'gpt-4o-mini',
  baseUrl: 'https://api.openai.com/v1',
  config: {},
  apiKey: 'k',
} as never

const BASE_INPUT = {
  chunkText: 'Some chunk content about TypeScript and GraphQL.',
  filename: 'design.md',
  chunkIndex: 2,
  totalChunks: 7,
  existingTopKeywords: ['react', 'typescript', 'graphql'],
  workspaceId: 'ws-1',
  inferenceEndpointId: 'ep-1',
  endpoint: FAKE_ENDPOINT,
}

describe('buildKeywordExtractionPrompt', () => {
  it('substitutes filename, position i+1/total, existingKeywords, and chunkText', () => {
    const prompt = buildKeywordExtractionPrompt({
      chunkText: 'hello world',
      filename: 'design.md',
      chunkIndex: 2,
      totalChunks: 7,
      existingTopKeywords: ['alpha', 'beta'],
    })
    expect(prompt.system).toMatch(/strict JSON/i)
    expect(prompt.user).toContain('File: design.md')
    expect(prompt.user).toContain('Chunk: 3/7')
    expect(prompt.user).toContain('alpha, beta')
    expect(prompt.user).toContain('hello world')
  })

  it('shows "(none)" when existingTopKeywords is empty', () => {
    const prompt = buildKeywordExtractionPrompt({
      chunkText: 'x',
      filename: 'f.md',
      chunkIndex: 0,
      totalChunks: 1,
      existingTopKeywords: [],
    })
    expect(prompt.user).toContain('(none)')
    expect(prompt.user).toContain('Chunk: 1/1')
  })

  it('truncates chunk text past the cap', () => {
    const big = 'a'.repeat(5000)
    const prompt = buildKeywordExtractionPrompt({
      chunkText: big,
      filename: 'f.md',
      chunkIndex: 0,
      totalChunks: 1,
      existingTopKeywords: [],
    })
    expect(prompt.user).toContain('…')
    expect(prompt.user.length).toBeLessThan(big.length + 1000)
  })
})

describe('extractKeywordsForChunk', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function setLLM(keywords: unknown) {
    mockExecute.mockResolvedValue({ content: JSON.stringify({ keywords }) })
  }

  it('returns canonical/display pairs for a valid 5-keyword response', async () => {
    setLLM(['React', 'TypeScript', 'GraphQL', 'API', 'Schema'])
    const out = await extractKeywordsForChunk(BASE_INPUT)
    expect(out).toHaveLength(5)
    expect(out.map((k) => k.canonical)).toEqual(['react', 'typescript', 'graphql', 'api', 'schema'])
  })

  it('returns [] when fewer than 3 keywords are present', async () => {
    setLLM(['only', 'two'])
    const out = await extractKeywordsForChunk(BASE_INPUT)
    expect(out).toEqual([])
  })

  it('returns [] when the LLM returns 0 keywords', async () => {
    setLLM([])
    const out = await extractKeywordsForChunk(BASE_INPUT)
    expect(out).toEqual([])
  })

  it('clamps a 12-keyword response down to 10', async () => {
    setLLM(['a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'g7', 'h8', 'i9', 'j10', 'k11', 'l12'])
    const out = await extractKeywordsForChunk(BASE_INPUT)
    expect(out).toHaveLength(10)
  })

  it('rejects junk entries: empties, > 60 chars, letter-less, multi-word', async () => {
    const long = 'x'.repeat(70)
    setLLM(['valid', '', long, '12345', 'valid two', 'fade-out', 'auth', 'sso'])
    const out = await extractKeywordsForChunk(BASE_INPUT)
    expect(out.map((k) => k.canonical)).toEqual(['valid', 'fade-out', 'auth', 'sso'])
  })

  it('dedupes by canonical form', async () => {
    setLLM(['Alpha', 'alpha', 'Beta', 'BETA', 'gamma'])
    const out = await extractKeywordsForChunk(BASE_INPUT)
    expect(out.map((k) => k.canonical)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('tolerates JSON wrapped in markdown fences', async () => {
    mockExecute.mockResolvedValue({
      content: '```json\n{ "keywords": ["one", "two", "three"] }\n```',
    })
    const out = await extractKeywordsForChunk(BASE_INPUT)
    expect(out.map((k) => k.canonical)).toEqual(['one', 'two', 'three'])
  })

  it('returns [] when inference throws a non-fatal error', async () => {
    mockExecute.mockRejectedValue(new Error('boom'))
    const out = await extractKeywordsForChunk(BASE_INPUT)
    expect(out).toEqual([])
  })

  it('throws KeywordInferenceFatalError on a 401 auth failure (so callers fail fast, not per-chunk)', async () => {
    mockExecute.mockRejectedValue(
      new Error('inference request failed: 401 Unauthorized Missing Authentication header')
    )
    await expect(extractKeywordsForChunk(BASE_INPUT)).rejects.toBeInstanceOf(
      KeywordInferenceFatalError
    )
  })

  it('returns [] and skips inference when no endpoint can be resolved', async () => {
    mockResolveEndpoint.mockResolvedValue(null)
    const out = await extractKeywordsForChunk({ ...BASE_INPUT, endpoint: undefined })
    expect(out).toEqual([])
    expect(mockExecute).not.toHaveBeenCalled()
  })
})
