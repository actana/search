/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executeWorkspaceInference, type WorkspaceInferenceEndpoint } from './inference.ts'

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('executeWorkspaceInference', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const openai: WorkspaceInferenceEndpoint = {
    id: 'ep-1',
    providerId: 'openai-compatible',
    template: 'openai',
    modelName: 'gpt-4o-mini',
    apiKey: 'sk-test',
    baseUrl: 'https://api.openai.com/v1',
  }

  it('openai-chat: POSTs to /chat/completions and extracts content', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: 'hi there' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      })
    )
    const res = await executeWorkspaceInference({
      endpoint: openai,
      messages: [{ role: 'user', content: 'hi' }],
      options: { temperature: 0.2, maxTokens: 64 },
    })
    expect(res.content).toBe('hi there')
    expect(res.finishReason).toBe('stop')
    expect(res.usage?.totalTokens).toBe(3)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/chat/completions')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.max_tokens).toBe(64)
    expect(body.temperature).toBe(0.2)
  })

  it('anthropic-messages: splits system, sends max_tokens default and anthropic-version', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        content: [{ text: 'answer' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 3, output_tokens: 5 },
      })
    )
    const res = await executeWorkspaceInference({
      endpoint: {
        ...openai,
        providerId: 'anthropic-messages',
        template: 'anthropic-direct',
        baseUrl: 'https://api.anthropic.com/v1',
        modelName: 'claude-sonnet-4-6',
      },
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ],
    })
    expect(res.content).toBe('answer')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-test')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.system).toBe('be brief')
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(body.max_tokens).toBe(1024)
  })

  it('google-generate: maps assistant→model and uses key query', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        candidates: [
          {
            content: { parts: [{ text: 'gem-out' }] },
            finishReason: 'STOP',
          },
        ],
      })
    )
    const res = await executeWorkspaceInference({
      endpoint: {
        ...openai,
        providerId: 'google-genai',
        template: 'gemini-api',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        modelName: 'gemini-1.5-flash',
      },
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a' },
      ],
    })
    expect(res.content).toBe('gem-out')
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain(':generateContent?key=sk-test')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.systemInstruction.parts[0].text).toBe('sys')
    expect(body.contents[1].role).toBe('model')
  })

  it('cohere-chat: parses message.content[0].text', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        message: { content: [{ text: 'cohere-out' }] },
        finish_reason: 'COMPLETE',
      })
    )
    const res = await executeWorkspaceInference({
      endpoint: {
        ...openai,
        providerId: 'cohere',
        template: 'cohere-direct',
        baseUrl: 'https://api.cohere.com',
        modelName: 'command-r',
      },
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res.content).toBe('cohere-out')
    const [url] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('https://api.cohere.com/v2/chat')
  })

  it('azure openai-chat: deployment URL with api-version', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      })
    )
    await executeWorkspaceInference({
      endpoint: {
        ...openai,
        template: 'azure-openai',
        baseUrl: 'https://my.openai.azure.com',
        config: { extras: { deployment: 'd1', apiVersion: '2024-06-01' } },
      },
      messages: [{ role: 'user', content: 'hi' }],
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe(
      'https://my.openai.azure.com/openai/deployments/d1/chat/completions?api-version=2024-06-01'
    )
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['api-key']).toBe('sk-test')
  })

  it('throws on non-2xx', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }))
    await expect(
      executeWorkspaceInference({
        endpoint: openai,
        messages: [{ role: 'user', content: 'hi' }],
      })
    ).rejects.toThrow(/inference request failed: 500/)
  })
})
