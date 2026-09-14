/**
 * Tests for the OCR hand-off (ticket 17, D5): external documents are fetched
 * through the hardened download path and re-hosted on our storage — the OCR
 * provider never receives the raw user URL, and an SSRF-rejected URL fails
 * the parse before any hand-off.
 *
 * @vitest-environment node
 */
import { createEnvMock } from '@actana/search-shared/testing/mocks'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  mockDownloadFileFromUrl: vi.fn(),
  mockUploadFile: vi.fn(),
  mockGeneratePresignedDownloadUrl: vi.fn(),
  mockIsInternalFileUrl: vi.fn(),
  mockGetModelEndpoint: vi.fn(),
}))

vi.mock('../../config.ts', () => createEnvMock({}))

// lifted: the workspace BYOK lookup (`@/lib/api-key/model-endpoints`) and the
// Mistral block tool (`@/tools/mistral/parser`) are not lifted, so their mocks
// went with them. Studio also mocked `@/lib/uploads`, `.../file-utils` and
// `.../file-utils.server` separately; all three are `blob/index.ts` here, so
// the three factories are one — a second `vi.mock` of the same path would
// silently replace the first.
vi.mock('../../blob/index.ts', () => ({
  StorageService: {
    uploadFile: mocks.mockUploadFile,
    generatePresignedDownloadUrl: mocks.mockGeneratePresignedDownloadUrl,
  },
  isInternalFileUrl: mocks.mockIsInternalFileUrl,
  downloadFileFromUrl: mocks.mockDownloadFileFromUrl,
  SUPPORTED_DOCUMENT_EXTENSIONS: ['pdf', 'txt', 'md'],
  isAlphanumericExtension: (e: string) => /^[a-z0-9]+$/.test(e),
  isSupportedExtension: (e: string) => ['pdf', 'txt', 'md'].includes(e),
  getExtensionFromMimeType: () => null,
  MAX_UPLOAD_SIZE_BYTES: 50 * 1024 * 1024,
}))

import { handleFileForOCR } from './document-processor.ts'

describe('handleFileForOCR', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockIsInternalFileUrl.mockImplementation((url: string) =>
      url.includes('/api/files/serve/')
    )
    mocks.mockDownloadFileFromUrl.mockResolvedValue(Buffer.from('document bytes'))
    mocks.mockUploadFile.mockResolvedValue({ key: 'kb/123-abc-doc.docx' })
    mocks.mockGeneratePresignedDownloadUrl.mockResolvedValue(
      'https://our-bucket.example.com/kb/123-abc-doc.docx?signed'
    )
  })

  it('re-hosts an external document instead of handing its URL to the provider', async () => {
    const userUrl = 'https://evil.example.com/doc.docx'

    const result = await handleFileForOCR(userUrl, 'doc.docx', 'application/msword', 'user-1', 'ws-1')

    expect(mocks.mockDownloadFileFromUrl).toHaveBeenCalledWith(userUrl, expect.any(Number))
    expect(mocks.mockUploadFile).toHaveBeenCalledWith(
      expect.objectContaining({ file: Buffer.from('document bytes'), context: 'knowledge-base' })
    )
    expect(result.httpsUrl).toBe('https://our-bucket.example.com/kb/123-abc-doc.docx?signed')
    expect(result.httpsUrl).not.toContain('evil.example.com')
    expect(result.buffer).toEqual(Buffer.from('document bytes'))
  })

  it('fails the parse when the hardened download rejects the URL — no hand-off fallback', async () => {
    mocks.mockDownloadFileFromUrl.mockRejectedValue(
      new Error('Invalid file URL: resolves to a private IP')
    )

    await expect(
      handleFileForOCR('https://169.254.169.254/latest/meta-data', 'doc.pdf', 'application/pdf')
    ).rejects.toThrow('private IP')
    expect(mocks.mockUploadFile).not.toHaveBeenCalled()
    expect(mocks.mockGeneratePresignedDownloadUrl).not.toHaveBeenCalled()
  })

  it('keeps the existing re-host flow for internal files', async () => {
    const internalUrl = '/api/files/serve/s3/kb%2Fexisting.pdf'

    const result = await handleFileForOCR(internalUrl, 'existing.pdf', 'application/pdf')

    expect(mocks.mockDownloadFileFromUrl).toHaveBeenCalledWith(internalUrl, expect.any(Number))
    expect(result.httpsUrl).toBe('https://our-bucket.example.com/kb/123-abc-doc.docx?signed')
  })
})
