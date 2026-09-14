/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executeWorkspaceEmbedding, type WorkspaceEmbeddingEndpoint } from './embedding.ts'

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('executeWorkspaceEmbedding', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const base: WorkspaceEmbeddingEndpoint = {
    id: 'ep-1',
    providerId: 'openai-compatible',
    template: 'openai',
    modelName: 'text-embedding-3-small',
    apiKey: 'sk-test',
    baseUrl: 'https://api.openai.com/v1',
    dimensions: 1536,
    config: {},
  }

  it('openai-embed: POSTs to /embeddings and parses data[].embedding', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }],
        usage: { prompt_tokens: 5, total_tokens: 5 },
      })
    )
    const res = await executeWorkspaceEmbedding({ endpoint: base, input: ['a', 'b'] })
    expect(res.embeddings).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ])
    expect(res.dimensions).toBe(1536)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/embeddings')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['authorization']).toBe('Bearer sk-test')
  })

  it('google-embed: single input uses embedContent with ?key=', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ embedding: { values: [0.1, 0.2, 0.3] } }))
    const res = await executeWorkspaceEmbedding({
      endpoint: {
        ...base,
        providerId: 'google-genai',
        template: 'gemini-api',
        modelName: 'text-embedding-004',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        dimensions: 768,
      },
      input: 'hello',
    })
    expect(res.embeddings).toEqual([[0.1, 0.2, 0.3]])
    const [url] = fetchMock.mock.calls[0]
    expect(String(url)).toContain(':embedContent?key=sk-test')
  })

  it('google-embed: multi-input uses batchEmbedContents', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        embeddings: [{ values: [0.1] }, { values: [0.2] }],
      })
    )
    const res = await executeWorkspaceEmbedding({
      endpoint: {
        ...base,
        providerId: 'google-genai',
        template: 'gemini-api',
        modelName: 'text-embedding-004',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        dimensions: 768,
      },
      input: ['a', 'b'],
    })
    expect(res.embeddings).toEqual([[0.1], [0.2]])
    const [url] = fetchMock.mock.calls[0]
    expect(String(url)).toContain(':batchEmbedContents?key=')
  })

  it('voyage-embed: sends input_type=document by default', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ embedding: [0.5] }] }))
    await executeWorkspaceEmbedding({
      endpoint: {
        ...base,
        providerId: 'voyage',
        template: 'voyage',
        modelName: 'voyage-3',
        baseUrl: 'https://api.voyageai.com/v1',
        dimensions: 1024,
      },
      input: 'hi',
    })
    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.input_type).toBe('document')
  })

  it('cohere-embed: parses embeddings.float', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ embeddings: { float: [[0.1, 0.2]] } }))
    const res = await executeWorkspaceEmbedding({
      endpoint: {
        ...base,
        providerId: 'cohere',
        template: 'cohere-direct',
        modelName: 'embed-english-v3.0',
        baseUrl: 'https://api.cohere.com',
        dimensions: 1024,
      },
      input: 'hi',
    })
    expect(res.embeddings).toEqual([[0.1, 0.2]])
    const [url] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('https://api.cohere.com/v2/embed')
  })

  it('azure: builds deployment URL with api-version', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ embedding: [0.1] }] }))
    await executeWorkspaceEmbedding({
      endpoint: {
        ...base,
        template: 'azure-openai',
        baseUrl: 'https://my-resource.openai.azure.com',
        config: { extras: { deployment: 'my-deploy', apiVersion: '2024-06-01' } },
      },
      input: 'hi',
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe(
      'https://my-resource.openai.azure.com/openai/deployments/my-deploy/embeddings?api-version=2024-06-01'
    )
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['api-key']).toBe('sk-test')
  })

  it('custom: traverses outputPath', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ vec: [0.9, 0.8] }))
    const res = await executeWorkspaceEmbedding({
      endpoint: {
        ...base,
        template: 'custom',
        baseUrl: 'https://example.test/embed',
        config: {
          custom: { inputField: 'text', outputPath: 'vec', requestShape: 'custom' },
        },
      },
      input: 'hi',
    })
    expect(res.embeddings).toEqual([[0.9, 0.8]])
  })

  it('throws on non-2xx', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }))
    await expect(executeWorkspaceEmbedding({ endpoint: base, input: 'hi' })).rejects.toThrow(
      /embedding request failed: 500/
    )
  })
})
