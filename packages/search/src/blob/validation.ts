/**
 * Upload validation. Lifted from Studio's `lib/uploads/utils/validation.ts`,
 * trimmed to what the engine reads: the extension vocabulary the parsers
 * recognise and the one size cap every ingest path is checked against.
 *
 * lifted: the audio, video, image and code extension tables went with the rest
 * of Studio's upload surface — a knowledge base ingests documents, and a mode
 * the engine cannot parse is not a mode this file should claim to support.
 */

/**
 * Checks whether a string is a valid file extension (lowercase alphanumeric only).
 * Rejects extensions containing spaces, punctuation, or other non-alphanumeric characters
 * that arise from non-filename document names (e.g. "Actana <> RVTech").
 */
export function isAlphanumericExtension(ext: string): boolean {
  return /^[a-z0-9]+$/.test(ext)
}

/**
 * The single upload size cap enforced on every ingest path. Checked against the
 * declared size before any request body is buffered — a route must not accept a
 * larger file through any door.
 */
export const MAX_UPLOAD_SIZE_BYTES = 50 * 1024 * 1024

/**
 * Slack allowed on top of {@link MAX_UPLOAD_SIZE_BYTES} for multipart form
 * framing and non-file fields when prechecking a request's Content-Length.
 * Individual files are still capped at exactly {@link MAX_UPLOAD_SIZE_BYTES}.
 */
export const FORM_OVERHEAD_SLACK_BYTES = 1024 * 1024

export function requestBodyExceedsUploadCap(contentLengthHeader: string | null): boolean {
  if (!contentLengthHeader) return false
  const declared = Number.parseInt(contentLengthHeader, 10)
  if (!Number.isFinite(declared)) return false
  return declared > MAX_UPLOAD_SIZE_BYTES + FORM_OVERHEAD_SLACK_BYTES
}

export const SUPPORTED_DOCUMENT_EXTENSIONS = [
  'pdf',
  'csv',
  'doc',
  'docx',
  'txt',
  'md',
  'xlsx',
  'ppt',
  'pptx',
  'html',
  'htm',
  'json',
  'jsonl',
  'yaml',
  'yml',
] as const

/**
 * Extensions the engine once parsed and deliberately no longer does, with the
 * reason a caller is told. Checked before any fallback, so a retired binary
 * format is refused by name instead of being read as plain text.
 */
export const RETIRED_DOCUMENT_EXTENSIONS: Readonly<Record<string, string>> = {
  // ADR 0012: SheetJS was the only `.xls` reader and it was removed.
  xls: 'legacy binary Excel (.xls) is not supported; save the workbook as .xlsx',
}

/** The refusal reason for a retired extension, or `undefined` when it is not retired. */
export function retiredExtensionReason(extension: string): string | undefined {
  return Object.hasOwn(RETIRED_DOCUMENT_EXTENSIONS, extension.toLowerCase())
    ? RETIRED_DOCUMENT_EXTENSIONS[extension.toLowerCase()]
    : undefined
}

export type SupportedDocumentExtension = (typeof SUPPORTED_DOCUMENT_EXTENSIONS)[number]

/** Check if a file extension is supported. */
export function isSupportedExtension(extension: string): extension is SupportedDocumentExtension {
  return SUPPORTED_DOCUMENT_EXTENSIONS.includes(
    extension.toLowerCase() as SupportedDocumentExtension
  )
}
