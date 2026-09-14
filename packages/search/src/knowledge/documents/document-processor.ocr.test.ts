/**
 * The Mistral OCR call, as a wire contract.
 *
 * `parseDocument` routes every PDF here when a key is configured, so what this
 * sends and how it reads the reply is the difference between a scanned document
 * becoming text and becoming nothing. The assertions are deliberately literal —
 * endpoint, method, bearer header, body shape, model id — because they are
 * copied from Studio's `/api/tools/mistral/parse` route and a drift in any of
 * them is a behaviour change (ADR 0005).
 *
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockValidate, mockFetch } = vi.hoisted(() => ({
  mockValidate: vi.fn(),
  mockFetch: vi.fn(),
}))

vi.mock('../../core/security/url-guard.ts', () => ({
  validateUrlWithDNS: mockValidate,
  secureFetchWithPinnedIP: mockFetch,
}))
vi.mock('../../blob/index.ts', () => ({
  StorageService: { uploadFile: vi.fn(), generatePresignedDownloadUrl: vi.fn() },
  isInternalFileUrl: () => false,
  downloadFileFromUrl: vi.fn(),
  // Reached through `parser-extension.ts`, which the module graph pulls in.
  SUPPORTED_DOCUMENT_EXTENSIONS: ['pdf', 'txt', 'md'],
  isAlphanumericExtension: (e: string) => /^[a-z0-9]+$/.test(e),
  isSupportedExtension: (e: string) => ['pdf', 'txt', 'md'].includes(e),
  getExtensionFromMimeType: () => null,
  MAX_UPLOAD_SIZE_BYTES: 50 * 1024 * 1024,
}))
vi.mock('../../models/source.ts', () => ({ getEndpointSource: vi.fn() }))

import { requestMistralOCR } from './document-processor.ts'

const ok = (body: unknown) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  json: async () => body,
  text: async () => JSON.stringify(body),
})

describe('requestMistralOCR', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockValidate.mockResolvedValue({ isValid: true, resolvedIP: '203.0.113.7' })
  })

  it('posts the document url to Mistral with the key, and joins the page markdown', async () => {
    mockFetch.mockResolvedValue(
      ok({ pages: [{ markdown: '# One' }, { markdown: 'Two' }, {}, { markdown: 'Three' }] }),
    )

    const content = await requestMistralOCR('https://blobs.example/doc.pdf?sig=abc', 'sk-test')

    // Page markdown, in order, blank pages dropped, joined by a blank line.
    expect(content).toBe('# One\n\nTwo\n\nThree')

    expect(mockValidate).toHaveBeenCalledWith('https://api.mistral.ai/v1/ocr', 'Mistral API URL')
    const [url, ip, options] = mockFetch.mock.calls[0] as unknown as [
      string,
      string,
      { method: string; headers: Record<string, string>; body: string },
    ]
    expect(url).toBe('https://api.mistral.ai/v1/ocr')
    // The address the validator resolved — not a second lookup.
    expect(ip).toBe('203.0.113.7')
    expect(options.method).toBe('POST')
    expect(options.headers.Authorization).toBe('Bearer sk-test')
    expect(JSON.parse(options.body)).toEqual({
      model: 'mistral-ocr-latest',
      document: { type: 'document_url', document_url: 'https://blobs.example/doc.pdf?sig=abc' },
      include_image_base64: false,
    })
  })

  it('returns empty content for a reply with no pages, rather than inventing any', async () => {
    mockFetch.mockResolvedValue(ok({}))
    expect(await requestMistralOCR('https://blobs.example/doc.pdf', 'sk-test')).toBe('')
  })

  it('refuses to call an endpoint the guard rejected', async () => {
    mockValidate.mockResolvedValue({ isValid: false, error: 'resolves to a blocked IP address' })
    await expect(requestMistralOCR('https://blobs.example/doc.pdf', 'sk-test')).rejects.toThrow(
      /Failed to reach the Mistral API/,
    )
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('retries a failing call and then surfaces the provider error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      text: async () => 'rate limited',
      json: async () => ({}),
    })

    await expect(requestMistralOCR('https://blobs.example/doc.pdf', 'sk-test')).rejects.toThrow(
      /Mistral OCR API error 429/,
    )
    // `retryWithExponentialBackoff`, three retries on top of the first attempt.
    expect(mockFetch).toHaveBeenCalledTimes(4)
  }, 30_000)
})
