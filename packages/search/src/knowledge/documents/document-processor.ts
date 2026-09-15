import { createLogger } from '@actana/search-shared/log'
import { PDFDocument } from 'pdf-lib'
import {
  type Chunk,
  JsonYamlChunker,
  RecursiveChunker,
  RegexChunker,
  SentenceChunker,
  StructuredDataChunker,
  TextChunker,
  TokenChunker,
} from '@actana/search-shared/chunkers/index'
import type { ChunkingStrategy, StrategyOptions } from '@actana/search-shared/chunkers/types'
import { tokensToChars } from '@actana/search-shared/chunkers/utils'
import { env } from '../../config.ts'
import { parseBuffer, parseFile } from '@actana/search-shared/file-parsers/index'
import type { FileParseMetadata } from '@actana/search-shared/file-parsers/types'
import { resolveParserExtension } from './parser-extension.ts'
import { retryWithExponentialBackoff } from './utils.ts'
import { StorageService } from '../../blob/index.ts'
import { isInternalFileUrl } from '../../blob/index.ts'
import { downloadFileFromUrl } from '../../blob/index.ts'
import {
  secureFetchWithPinnedIP,
  validateUrlWithDNS,
} from '../../core/security/url-guard.ts'
import { getEndpointSource } from '../../models/source.ts'

const logger = createLogger('DocumentProcessor')

const TIMEOUTS = {
  FILE_DOWNLOAD: 600000,
  MISTRAL_OCR_API: 120000,
} as const

const MAX_CONCURRENT_CHUNKS = env.KB_CONFIG_CHUNK_CONCURRENCY

/**
 * Hard per-document chunk ceiling, shared with the post-chunk check in the
 * knowledge service. {@link processDocument} also trips it *before*
 * materializing chunks whenever the lower-bound estimate
 * (content length / chunk size) is already over the limit, so a decompression
 * bomb cannot exhaust memory building a chunk array that would be rejected
 * anyway.
 */
export const MAX_CHUNKS_PER_DOCUMENT = 100000

type OCRResult = {
  success: boolean
  error?: string
  output?: {
    content?: string
  }
}

type OCRPage = {
  markdown?: string
}

type OCRRequestBody = {
  model: string
  document: {
    type: string
    document_url: string
  }
  include_image_base64: boolean
}

const MISTRAL_MAX_PAGES = 1000

async function getPdfPageCount(buffer: Buffer): Promise<number> {
  try {
    const { getDocumentProxy } = await import('unpdf')
    const uint8Array = new Uint8Array(buffer)
    const pdf = await getDocumentProxy(uint8Array)
    return pdf.numPages
  } catch (error) {
    logger.warn('Failed to get PDF page count:', error)
    return 0
  }
}

async function splitPdfIntoChunks(
  pdfBuffer: Buffer,
  maxPages: number
): Promise<{ buffer: Buffer; startPage: number; endPage: number }[]> {
  const sourcePdf = await PDFDocument.load(pdfBuffer)
  const totalPages = sourcePdf.getPageCount()

  if (totalPages <= maxPages) {
    return [{ buffer: pdfBuffer, startPage: 0, endPage: totalPages - 1 }]
  }

  const chunks: { buffer: Buffer; startPage: number; endPage: number }[] = []

  for (let startPage = 0; startPage < totalPages; startPage += maxPages) {
    const endPage = Math.min(startPage + maxPages - 1, totalPages - 1)
    const pageCount = endPage - startPage + 1

    const newPdf = await PDFDocument.create()
    const pageIndices = Array.from({ length: pageCount }, (_, i) => startPage + i)
    const copiedPages = await newPdf.copyPages(sourcePdf, pageIndices)

    copiedPages.forEach((page) => newPdf.addPage(page))

    const pdfBytes = await newPdf.save()
    chunks.push({
      buffer: Buffer.from(pdfBytes),
      startPage,
      endPage,
    })
  }

  return chunks
}

type AzureOCRResponse = {
  pages?: OCRPage[]
  [key: string]: unknown
}

class APIError extends Error {
  public status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'APIError'
    this.status = status
  }
}

async function applyStrategy(
  strategy: ChunkingStrategy,
  content: string,
  chunkSize: number,
  chunkOverlap: number,
  minCharactersPerChunk: number,
  strategyOptions?: StrategyOptions
): Promise<Chunk[]> {
  const baseOptions = { chunkSize, chunkOverlap, minCharactersPerChunk }

  switch (strategy) {
    case 'token': {
      const chunker = new TokenChunker(baseOptions)
      return chunker.chunk(content)
    }
    case 'sentence': {
      const chunker = new SentenceChunker(baseOptions)
      return chunker.chunk(content)
    }
    case 'recursive': {
      const chunker = new RecursiveChunker({
        ...baseOptions,
        separators: strategyOptions?.separators,
        recipe: strategyOptions?.recipe,
      })
      return chunker.chunk(content)
    }
    case 'regex': {
      if (!strategyOptions?.pattern) {
        logger.warn(
          'Regex strategy requested but no pattern provided, falling back to text chunker'
        )
        const chunker = new TextChunker(baseOptions)
        return chunker.chunk(content)
      }
      const chunker = new RegexChunker({
        ...baseOptions,
        pattern: strategyOptions.pattern,
      })
      return chunker.chunk(content)
    }
    default: {
      const chunker = new TextChunker(baseOptions)
      return chunker.chunk(content)
    }
  }
}

export async function processDocument(
  fileUrl: string,
  filename: string,
  mimeType: string,
  chunkSize = 1024,
  chunkOverlap = 200,
  minCharactersPerChunk = 100,
  userId?: string,
  workspaceId?: string | null,
  strategy?: ChunkingStrategy,
  strategyOptions?: StrategyOptions
): Promise<{
  chunks: Chunk[]
  metadata: {
    filename: string
    fileSize: number
    mimeType: string
    chunkCount: number
    tokenCount: number
    characterCount: number
    processingMethod: 'file-parser' | 'mistral-ocr'
    cloudUrl?: string
  }
}> {
  logger.info(`Processing document: ${filename}`)

  try {
    const parseResult = await parseDocument(fileUrl, filename, mimeType, userId, workspaceId)
    const { content, processingMethod } = parseResult
    const cloudUrl = 'cloudUrl' in parseResult ? parseResult.cloudUrl : undefined

    /**
     * `chunkSize` is a token budget (~4 chars per token), so the guaranteed
     * character ceiling per chunk is `tokensToChars(chunkSize)`; doubled so
     * the estimate stays a strict lower bound for every chunker and can never
     * reject a document that would have chunked under the limit.
     */
    const maxCharsPerChunk = tokensToChars(Math.max(1, chunkSize)) * 2
    const minimumChunkCount = Math.ceil(content.length / maxCharsPerChunk)
    if (minimumChunkCount > MAX_CHUNKS_PER_DOCUMENT) {
      throw new Error(
        `Document would produce at least ${minimumChunkCount.toLocaleString()} chunks, exceeding the maximum of ${MAX_CHUNKS_PER_DOCUMENT.toLocaleString()}. ` +
          `This document is unusually large and may need to be split into multiple files or preprocessed to reduce content.`
      )
    }

    let chunks: Chunk[]
    const metadata: FileParseMetadata = parseResult.metadata ?? {}

    if (strategy && strategy !== 'auto') {
      logger.info(`Using explicit chunking strategy: ${strategy}`)
      chunks = await applyStrategy(
        strategy,
        content,
        chunkSize,
        chunkOverlap,
        minCharactersPerChunk,
        strategyOptions
      )
    } else {
      const isJsonYaml =
        metadata.type === 'json' ||
        metadata.type === 'yaml' ||
        mimeType.includes('json') ||
        mimeType.includes('yaml')

      if (isJsonYaml && JsonYamlChunker.isStructuredData(content)) {
        logger.info('Using JSON/YAML chunker for structured data')
        chunks = await JsonYamlChunker.chunkJsonYaml(content, {
          chunkSize,
          minCharactersPerChunk,
        })
      } else if (StructuredDataChunker.isStructuredData(content, mimeType)) {
        logger.info('Using structured data chunker for spreadsheet/CSV content')
        const rowCount = metadata.totalRows ?? metadata.rowCount
        chunks = await StructuredDataChunker.chunkStructuredData(content, {
          chunkSize,
          headers: metadata.headers,
          totalRows: typeof rowCount === 'number' ? rowCount : undefined,
          sheetName: metadata.sheetNames?.[0],
        })
      } else {
        const chunker = new TextChunker({ chunkSize, chunkOverlap, minCharactersPerChunk })
        chunks = await chunker.chunk(content)
      }
    }

    const characterCount = content.length
    const tokenCount = chunks.reduce((sum, chunk) => sum + chunk.tokenCount, 0)

    logger.info(`Document processed: ${chunks.length} chunks, ${tokenCount} tokens`)

    return {
      chunks,
      metadata: {
        filename,
        fileSize: characterCount,
        mimeType,
        chunkCount: chunks.length,
        tokenCount,
        characterCount,
        processingMethod,
        cloudUrl,
      },
    }
  } catch (error) {
    logger.error(`Error processing document ${filename}:`, error)
    throw error
  }
}

/**
 * The Mistral OCR key: the paired client's registered `mistral` endpoint first,
 * then the instance-level `MISTRAL_API_KEY`.
 *
 * lifted: Studio read `workspace_model_endpoints` directly through
 * `getModelEndpoint(workspaceId, 'mistral')`. The lookup goes through
 * `ModelEndpointSource` instead, which is the same row standalone and is
 * resolved from the paired client per job when wired (ADR 0004). Same
 * precedence, same fallback.
 */
async function getMistralApiKey(pairedClientId?: string | null): Promise<string | null> {
  if (pairedClientId) {
    try {
      const source = await getEndpointSource()
      const key = await source.providerKey({ pairedClientId, provider: 'mistral' })
      if (key) {
        logger.info('Using the paired client\'s Mistral endpoint key for OCR')
        return key
      }
    } catch (error) {
      logger.warn('Failed to resolve a Mistral endpoint key; falling back to MISTRAL_API_KEY', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return env.MISTRAL_API_KEY || null
}

async function parseDocument(
  fileUrl: string,
  filename: string,
  mimeType: string,
  userId?: string,
  workspaceId?: string | null
): Promise<{
  content: string
  processingMethod: 'file-parser' | 'mistral-ocr'
  cloudUrl?: string
  metadata?: FileParseMetadata
}> {
  const isPDF = mimeType === 'application/pdf'
  const hasAzureMistralOCR =
    env.OCR_AZURE_API_KEY && env.OCR_AZURE_ENDPOINT && env.OCR_AZURE_MODEL_NAME

  const mistralApiKey = await getMistralApiKey(workspaceId)
  const hasMistralOCR = !!mistralApiKey

  if (isPDF && (hasAzureMistralOCR || hasMistralOCR)) {
    if (hasAzureMistralOCR) {
      logger.info(`Using Azure Mistral OCR: ${filename}`)
      return parseWithAzureMistralOCR(fileUrl, filename, mimeType)
    }

    if (hasMistralOCR) {
      logger.info(`Using Mistral OCR: ${filename}`)
      return parseWithMistralOCR(fileUrl, filename, mimeType, userId, workspaceId, mistralApiKey!)
    }
  }

  logger.info(`Using file parser: ${filename}`)
  return parseWithFileParser(fileUrl, filename, mimeType)
}

/**
 * Resolve a document into an OCR-safe location. External documents are never
 * handed to the OCR provider by their original URL (D5): the bytes are
 * fetched through the hardened download path — DNS validation, IP pinning,
 * redirect re-validation, byte cap — and re-hosted on our storage, so the
 * provider only ever fetches from us. A failed download fails the parse; it
 * must not fall back to the raw user URL.
 *
 * Exported for tests.
 */
export async function handleFileForOCR(
  fileUrl: string,
  filename: string,
  mimeType: string,
  userId?: string,
  workspaceId?: string | null
) {
  const isExternalHttps = fileUrl.startsWith('https://') && !isInternalFileUrl(fileUrl)

  logger.info(
    isExternalHttps
      ? `Downloading external document "${filename}" through the hardened path for OCR`
      : `Uploading "${filename}" to cloud storage for OCR`
  )

  const buffer = await downloadFileWithTimeout(fileUrl)

  logger.info(`Downloaded ${filename}: ${buffer.length} bytes`)

  try {
    const metadata: Record<string, string> = {
      originalName: filename,
      uploadedAt: new Date().toISOString(),
      purpose: 'knowledge-base',
      ...(userId && { userId }),
      ...(workspaceId && { workspaceId }),
    }

    const timestamp = Date.now()
    const uniqueId = Math.random().toString(36).substring(2, 9)
    const safeFileName = filename.replace(/[^a-zA-Z0-9.-]/g, '_')
    const customKey = `kb/${timestamp}-${uniqueId}-${safeFileName}`

    const cloudResult = await StorageService.uploadFile({
      file: buffer,
      fileName: filename,
      contentType: mimeType,
      context: 'knowledge-base',
      customKey,
      metadata,
    })

    const httpsUrl = await StorageService.generatePresignedDownloadUrl(
      cloudResult.key,
      'knowledge-base',
      900 // 15 minutes
    )

    return { httpsUrl, cloudUrl: httpsUrl, buffer }
  } catch (uploadError) {
    const message = uploadError instanceof Error ? uploadError.message : 'Unknown error'
    throw new Error(`Cloud upload failed: ${message}. Cloud upload is required for OCR.`)
  }
}

async function downloadFileWithTimeout(fileUrl: string): Promise<Buffer> {
  return downloadFileFromUrl(fileUrl, TIMEOUTS.FILE_DOWNLOAD)
}

async function downloadFileForBase64(fileUrl: string): Promise<Buffer> {
  if (fileUrl.startsWith('data:')) {
    const [, base64Data] = fileUrl.split(',')
    if (!base64Data) {
      throw new Error('Invalid data URI format')
    }
    return Buffer.from(base64Data, 'base64')
  }
  if (fileUrl.startsWith('http')) {
    return downloadFileWithTimeout(fileUrl)
  }
  const fs = await import('fs/promises')
  return fs.readFile(fileUrl)
}

function processOCRContent(result: OCRResult, filename: string): string {
  if (!result.success) {
    throw new Error(`OCR processing failed: ${result.error || 'Unknown error'}`)
  }

  const content = result.output?.content || ''
  if (!content.trim()) {
    throw new Error('OCR returned empty content')
  }

  logger.info(`OCR completed: ${filename}`)
  return content
}

function validateOCRConfig(
  apiKey?: string,
  endpoint?: string,
  modelName?: string,
  service = 'OCR'
) {
  if (!apiKey) throw new Error(`${service} API key required`)
  if (!endpoint) throw new Error(`${service} endpoint required`)
  if (!modelName) throw new Error(`${service} model name required`)
}

function extractPageContent(pages: OCRPage[]): string {
  if (!pages?.length) return ''

  return pages
    .map((page) => page?.markdown || '')
    .filter(Boolean)
    .join('\n\n')
}

async function makeOCRRequest(
  endpoint: string,
  headers: Record<string, string>,
  body: OCRRequestBody
): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.MISTRAL_OCR_API)

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      const errorText = await response.text()
      throw new APIError(
        `OCR failed: ${response.status} ${response.statusText} - ${errorText}`,
        response.status
      )
    }

    return response
  } catch (error) {
    clearTimeout(timeoutId)
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('OCR API request timed out')
    }
    throw error
  }
}

async function parseWithAzureMistralOCR(fileUrl: string, filename: string, mimeType: string) {
  validateOCRConfig(
    env.OCR_AZURE_API_KEY,
    env.OCR_AZURE_ENDPOINT,
    env.OCR_AZURE_MODEL_NAME,
    'Azure Mistral OCR'
  )

  const fileBuffer = await downloadFileForBase64(fileUrl)

  if (mimeType === 'application/pdf') {
    const pageCount = await getPdfPageCount(fileBuffer)
    if (pageCount > MISTRAL_MAX_PAGES) {
      logger.info(
        `PDF has ${pageCount} pages, exceeds Azure OCR limit of ${MISTRAL_MAX_PAGES}. ` +
          `Falling back to file parser.`
      )
      return parseWithFileParser(fileUrl, filename, mimeType)
    }
    logger.info(`Azure Mistral OCR: PDF page count for ${filename}: ${pageCount}`)
  }

  const base64Data = fileBuffer.toString('base64')
  const dataUri = `data:${mimeType};base64,${base64Data}`

  try {
    const response = await retryWithExponentialBackoff(
      () =>
        makeOCRRequest(
          env.OCR_AZURE_ENDPOINT!,
          {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${env.OCR_AZURE_API_KEY}`,
          },
          {
            model: env.OCR_AZURE_MODEL_NAME!,
            document: {
              type: 'document_url',
              document_url: dataUri,
            },
            include_image_base64: false,
          }
        ),
      { maxRetries: 3, initialDelayMs: 1000, maxDelayMs: 10000 }
    )

    const ocrResult = (await response.json()) as AzureOCRResponse
    const content = extractPageContent(ocrResult.pages || []) || JSON.stringify(ocrResult, null, 2)

    if (!content.trim()) {
      throw new Error('Azure Mistral OCR returned empty content')
    }

    logger.info(`Azure Mistral OCR completed: ${filename}`)
    return { content, processingMethod: 'mistral-ocr' as const, cloudUrl: undefined }
  } catch (error) {
    logger.error(`Azure Mistral OCR failed for ${filename}:`, {
      message: error instanceof Error ? error.message : String(error),
    })

    logger.info(`Falling back to file parser: ${filename}`)
    return parseWithFileParser(fileUrl, filename, mimeType)
  }
}

/**
 * Mistral OCR, called directly.
 *
 * lifted: Studio reached the same API through `mistralParserTool` — a *block
 * tool* definition, with parameter visibilities, hosting metadata and a
 * `transformResponse`, invoked over Studio's own `/api/tools/mistral/parse`
 * route with an internally-minted bearer token. None of that crosses: Search
 * has no block tools and no internal route to call. What the route actually did
 * is a single `POST https://api.mistral.ai/v1/ocr` with a bearer key, and that
 * is what this is. The request body, the model default, the page-markdown
 * concatenation and the retry policy are the same, so a document parses to the
 * same text it did in Studio.
 *
 * The document is handed over as a URL, never as bytes: `handleFileForOCR`
 * re-hosts it in Search's own bucket and mints a short-lived presigned URL, so
 * the provider fetches from us and never from a caller-supplied address.
 */
const MISTRAL_OCR_ENDPOINT = 'https://api.mistral.ai/v1/ocr'
const MISTRAL_OCR_MODEL = 'mistral-ocr-latest'

/** One OCR call. Returns the concatenated page markdown. Exported for tests. */
export async function requestMistralOCR(documentUrl: string, apiKey: string): Promise<string> {
  const validation = await validateUrlWithDNS(MISTRAL_OCR_ENDPOINT, 'Mistral API URL')
  if (!validation.isValid) {
    throw new Error(`Failed to reach the Mistral API: ${validation.error}`)
  }

  const response = await retryWithExponentialBackoff(
    async () => {
      const res = await secureFetchWithPinnedIP(MISTRAL_OCR_ENDPOINT, validation.resolvedIP!, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: MISTRAL_OCR_MODEL,
          document: { type: 'document_url', document_url: documentUrl },
          include_image_base64: false,
        }),
        timeout: TIMEOUTS.MISTRAL_OCR_API,
      })
      if (!res.ok) {
        const errorText = await res.text()
        throw new Error(`Mistral OCR API error ${res.status}: ${errorText.slice(0, 500)}`)
      }
      return res
    },
    { maxRetries: 3, initialDelayMs: 1000, maxDelayMs: 10000 }
  )

  const ocrResult = (await response.json()) as { pages?: OCRPage[] }
  return extractPageContent(ocrResult.pages || [])
}

/**
 * OCR a document with Mistral, splitting a PDF that exceeds the provider's page
 * limit into batches and running them with bounded concurrency.
 */
async function parseWithMistralOCR(
  fileUrl: string,
  filename: string,
  mimeType: string,
  userId: string | undefined,
  workspaceId: string | null | undefined,
  apiKey: string
): Promise<{
  content: string
  processingMethod: 'file-parser' | 'mistral-ocr'
  cloudUrl?: string
}> {
  try {
    const { httpsUrl, cloudUrl, buffer } = await handleFileForOCR(
      fileUrl,
      filename,
      mimeType,
      userId,
      workspaceId
    )

    const pageCount =
      mimeType === 'application/pdf' ? await getPdfPageCount(buffer) : 0

    if (pageCount > MISTRAL_MAX_PAGES) {
      logger.info(
        `PDF has ${pageCount} pages, over the ${MISTRAL_MAX_PAGES}-page limit — splitting: ${filename}`
      )
      const content = await parseMistralOCRInBatches(
        buffer,
        filename,
        mimeType,
        userId,
        workspaceId,
        apiKey
      )
      return {
        content: processOCRContent({ success: true, output: { content } }, filename),
        processingMethod: 'mistral-ocr' as const,
        cloudUrl,
      }
    }

    const content = await requestMistralOCR(httpsUrl, apiKey)
    return {
      content: processOCRContent({ success: true, output: { content } }, filename),
      processingMethod: 'mistral-ocr' as const,
      cloudUrl,
    }
  } catch (error) {
    logger.error(`Mistral OCR failed for ${filename}:`, {
      message: error instanceof Error ? error.message : String(error),
    })

    logger.info(`Falling back to file parser: ${filename}`)
    return parseWithFileParser(fileUrl, filename, mimeType)
  }
}

/**
 * Split an over-long PDF, OCR the pieces and stitch the text back together in
 * page order. Concurrency is {@link MAX_CONCURRENT_CHUNKS}: the provider rate
 * limits, and a 3,000-page document should not open 3,000 requests.
 */
async function parseMistralOCRInBatches(
  pdfBuffer: Buffer,
  filename: string,
  mimeType: string,
  userId: string | undefined,
  workspaceId: string | null | undefined,
  apiKey: string
): Promise<string> {
  const chunks = await splitPdfIntoChunks(pdfBuffer, MISTRAL_MAX_PAGES)
  const contents = new Array<string>(chunks.length).fill('')

  for (let start = 0; start < chunks.length; start += MAX_CONCURRENT_CHUNKS) {
    const window = chunks.slice(start, start + MAX_CONCURRENT_CHUNKS)
    await Promise.all(
      window.map(async (chunk, offset) => {
        const index = start + offset
        const chunkName = `${filename} (pages ${chunk.startPage + 1}-${chunk.endPage + 1})`
        logger.info(`Mistral OCR batch ${index + 1}/${chunks.length}: ${chunkName}`)

        const uploaded = await StorageService.uploadFile({
          file: chunk.buffer,
          fileName: `${chunk.startPage}-${chunk.endPage}-${filename}`,
          contentType: mimeType,
          context: 'knowledge-base',
          metadata: {
            originalName: filename,
            purpose: 'knowledge-base-ocr-batch',
            ...(userId && { userId }),
            ...(workspaceId && { workspaceId }),
          },
        })
        const presigned = await StorageService.generatePresignedDownloadUrl(
          uploaded.key,
          'knowledge-base',
          900
        )
        contents[index] = await requestMistralOCR(presigned, apiKey)
      })
    )
  }

  return contents.filter(Boolean).join('\n\n')
}

async function parseWithFileParser(fileUrl: string, filename: string, mimeType: string) {
  try {
    let content: string
    let metadata: FileParseMetadata = {}

    if (fileUrl.startsWith('data:')) {
      content = await parseDataURI(fileUrl, filename, mimeType)
    } else if (isInternalFileUrl(fileUrl)) {
      /**
       * A blob in Search's own bucket (ADR 0006). Studio's `file_url` for an
       * uploaded document was an absolute URL, so this branch had no work to do
       * there and the reference landed in `parseFile` below — a local path that
       * does not exist, which is why a REST ingest could not have parsed
       * anything without it. Added rather than lifted; the branch it precedes
       * is unchanged, and no path that worked before reaches a different
       * parser.
       */
      const result = await parseBlobFile(fileUrl, filename, mimeType)
      content = result.content
      metadata = result.metadata || {}
    } else if (fileUrl.startsWith('http')) {
      const result = await parseHttpFile(fileUrl, filename, mimeType)
      content = result.content
      metadata = result.metadata || {}
    } else {
      const result = await parseFile(fileUrl)
      content = result.content
      metadata = result.metadata || {}
    }

    if (!content.trim()) {
      throw new Error('File parser returned empty content')
    }

    return { content, processingMethod: 'file-parser' as const, cloudUrl: undefined, metadata }
  } catch (error) {
    logger.error(`File parser failed for ${filename}:`, error)
    throw error
  }
}

async function parseDataURI(fileUrl: string, filename: string, mimeType: string): Promise<string> {
  const [header, base64Data] = fileUrl.split(',')
  if (!base64Data) {
    throw new Error('Invalid data URI format')
  }

  if (mimeType === 'text/plain') {
    return header.includes('base64')
      ? Buffer.from(base64Data, 'base64').toString('utf8')
      : decodeURIComponent(base64Data)
  }

  const extension = resolveParserExtension(filename, mimeType, 'txt')
  const buffer = Buffer.from(base64Data, 'base64')
  const result = await parseBuffer(buffer, extension)
  return result.content
}

/** Parse a blob this instance holds: download the bytes, then parse them. */
async function parseBlobFile(
  fileUrl: string,
  filename: string,
  mimeType?: string
): Promise<{ content: string; metadata?: FileParseMetadata }> {
  const buffer = await downloadFileFromUrl(fileUrl, TIMEOUTS.FILE_DOWNLOAD)
  const extension = resolveParserExtension(filename, mimeType)
  return parseBuffer(buffer, extension)
}

async function parseHttpFile(
  fileUrl: string,
  filename: string,
  mimeType?: string
): Promise<{ content: string; metadata?: FileParseMetadata }> {
  const buffer = await downloadFileWithTimeout(fileUrl)

  const extension = resolveParserExtension(filename, mimeType)
  const result = await parseBuffer(buffer, extension)
  return result
}
