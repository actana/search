import { existsSync, statSync } from 'fs'
import path from 'path'
import { createLogger } from '../log.ts'
import { withPromiseTimeout } from '../promise-timeout.ts'
import { CsvParser } from './csv-parser.ts'
import { DocParser } from './doc-parser.ts'
import { DocxParser } from './docx-parser.ts'
import { HtmlParser } from './html-parser.ts'
import { parseJSON, parseJSONBuffer, parseJSONL, parseJSONLBuffer } from './json-parser.ts'
import { MdParser } from './md-parser.ts'
import { PdfParser } from './pdf-parser.ts'
import { PptxParser } from './pptx-parser.ts'
import { TxtParser } from './txt-parser.ts'
import type { FileParseResult, FileParser, SupportedFileType } from './types.ts'
import { XlsxParser } from './xlsx-parser.ts'
import { parseYAML, parseYAMLBuffer } from './yaml-parser.ts'

const logger = createLogger('FileParser')

/**
 * Throughput-based parse budget (mirrors the KB `computeProcessingTimeoutMs`
 * shape): every MB of input earns {@link PARSE_TIMEOUT_MS_PER_MB}, floored at
 * {@link MIN_PARSE_TIMEOUT_MS} and capped at {@link MAX_PARSE_TIMEOUT_MS}. A
 * legitimate large document clears it; a decompression bomb — tiny input,
 * unbounded expansion — trips the floor fast. The timeout rejects the parse
 * promise; it does not kill the process.
 */
export const PARSE_TIMEOUT_MS_PER_MB = 10 * 1000
export const MIN_PARSE_TIMEOUT_MS = 30 * 1000
export const MAX_PARSE_TIMEOUT_MS = 20 * 60 * 1000

/**
 * Compute the parse timeout (ms) for an input of `sizeBytes`. At least
 * {@link MIN_PARSE_TIMEOUT_MS}, at most {@link MAX_PARSE_TIMEOUT_MS},
 * scaling by {@link PARSE_TIMEOUT_MS_PER_MB} per (started) MB.
 */
export function computeParseTimeoutMs(sizeBytes: number | undefined | null): number {
  const size =
    typeof sizeBytes === 'number' && Number.isFinite(sizeBytes) ? Math.max(0, sizeBytes) : 0
  const megabytes = Math.ceil(size / (1024 * 1024))
  return Math.min(
    MAX_PARSE_TIMEOUT_MS,
    Math.max(MIN_PARSE_TIMEOUT_MS, megabytes * PARSE_TIMEOUT_MS_PER_MB)
  )
}

/**
 * Race a parse against its size-derived budget. On timeout the returned
 * promise rejects with a clean parse failure; the underlying parser may still
 * run to completion in the background (full out-of-process isolation is a
 * tracked follow-up).
 */
export async function withParseTimeout<T>(
  parse: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  return withPromiseTimeout(parse, timeoutMs, `Parsing ${label} timed out after ${timeoutMs}ms`)
}

/**
 * The parser registry.
 *
 * lifted: Studio built this lazily, inside a `getParserInstances()` that
 * `require()`d each parser in its own `try`/`catch` — a Next.js bundling
 * concern, keeping SheetJS, `mammoth`, `cheerio` and the PDF stack out of a
 * route's graph until something asked for them. Here it is a plain ESM object
 * built from static imports.
 *
 * It had to change: `require()` does not exist in an ES module, so under
 * Node the registry would have come up empty and every parse would have failed
 * with "Unsupported file type" — which is exactly the failure Studio's own
 * fixture suite works around by replacing this whole module under vitest. The
 * parser implementations, the extension mapping and the parse behaviour are
 * unchanged.
 *
 * The per-parser `try`/`catch` went with it. It let one parser's missing
 * dependency degrade to "that format is unsupported"; a static import makes it
 * a hard failure at startup instead. For a service whose entire job is reading
 * documents, a parser that cannot load is a deployment fault worth stopping
 * for, not one worth discovering on a user's upload.
 *
 * `xls` is not registered: SheetJS was the only parser for legacy binary Excel
 * and it is gone (ADR 0012). `.xlsx` has its own dependency-free parser.
 */
const parserInstances: Record<string, FileParser> = {
  pdf: new PdfParser(),
  csv: new CsvParser(),
  docx: new DocxParser(),
  doc: new DocParser(),
  txt: new TxtParser(),
  md: new MdParser(),
  xlsx: new XlsxParser(),
  pptx: new PptxParser(),
  ppt: new PptxParser(),
  html: new HtmlParser(),
  htm: new HtmlParser(),
  json: { parseFile: parseJSON, parseBuffer: parseJSONBuffer },
  jsonl: { parseFile: parseJSONL, parseBuffer: parseJSONLBuffer },
  yaml: { parseFile: parseYAML, parseBuffer: parseYAMLBuffer },
  yml: { parseFile: parseYAML, parseBuffer: parseYAMLBuffer },
}

/** The registry, under the name every call site already uses. */
function getParserInstances(): Record<string, FileParser> {
  return parserInstances
}

/**
 * Parse a file based on its extension
 * @param filePath Path to the file
 * @returns Parsed content and metadata
 */
export async function parseFile(filePath: string): Promise<FileParseResult> {
  try {
    if (!filePath) {
      throw new Error('No file path provided')
    }

    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`)
    }

    const extension = path.extname(filePath).toLowerCase().substring(1)
    logger.info('Attempting to parse file with extension:', extension)

    const parsers = getParserInstances()

    if (!Object.keys(parsers).includes(extension)) {
      logger.info('No parser found for extension:', extension)
      throw new Error(
        `Unsupported file type: ${extension}. Supported types are: ${Object.keys(parsers).join(', ')}`
      )
    }

    logger.info('Using parser for extension:', extension)
    const parser = parsers[extension]
    const timeoutMs = computeParseTimeoutMs(statSync(filePath).size)
    return await withParseTimeout(parser.parseFile(filePath), timeoutMs, path.basename(filePath))
  } catch (error) {
    logger.error('File parsing error:', error)
    throw error
  }
}

/**
 * Parse a buffer based on file extension
 * @param buffer Buffer containing the file data
 * @param extension File extension without the dot (e.g., 'pdf', 'csv')
 * @returns Parsed content and metadata
 */
export async function parseBuffer(buffer: Buffer, extension: string): Promise<FileParseResult> {
  try {
    if (!buffer || buffer.length === 0) {
      throw new Error('Empty buffer provided')
    }

    if (!extension) {
      throw new Error('No file extension provided')
    }

    const normalizedExtension = extension.toLowerCase()
    logger.info('Attempting to parse buffer with extension:', normalizedExtension)

    const parsers = getParserInstances()

    if (!Object.keys(parsers).includes(normalizedExtension)) {
      logger.info('No parser found for extension:', normalizedExtension)
      throw new Error(
        `Unsupported file type: ${normalizedExtension}. Supported types are: ${Object.keys(parsers).join(', ')}`
      )
    }

    logger.info('Using parser for extension:', normalizedExtension)
    const parser = parsers[normalizedExtension]

    if (parser.parseBuffer) {
      const timeoutMs = computeParseTimeoutMs(buffer.length)
      return await withParseTimeout(
        parser.parseBuffer(buffer),
        timeoutMs,
        `${normalizedExtension} buffer`
      )
    }
    throw new Error(`Parser for ${normalizedExtension} does not support buffer parsing`)
  } catch (error) {
    logger.error('Buffer parsing error:', error)
    throw error
  }
}

/**
 * Check if a file type is supported
 * @param extension File extension without the dot
 * @returns true if supported, false otherwise
 */
export function isSupportedFileType(extension: string): extension is SupportedFileType {
  try {
    return Object.keys(getParserInstances()).includes(extension.toLowerCase())
  } catch (error) {
    logger.error('Error checking supported file type:', error)
    return false
  }
}

export type { FileParseResult, FileParser, SupportedFileType }
