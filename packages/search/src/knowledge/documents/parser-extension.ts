import { getExtensionFromMimeType } from '../../blob/index.ts'
import {
  isAlphanumericExtension,
  isSupportedExtension,
  retiredExtensionReason,
  SUPPORTED_DOCUMENT_EXTENSIONS,
} from '../../blob/index.ts'

const SUPPORTED_EXTENSIONS_TEXT = SUPPORTED_DOCUMENT_EXTENSIONS.join(', ')

export function resolveParserExtension(
  filename: string,
  mimeType?: string,
  fallback?: string
): string {
  const raw = filename.includes('.') ? filename.split('.').pop()?.toLowerCase() : undefined
  const filenameExtension = raw && isAlphanumericExtension(raw) ? raw : undefined

  if (filenameExtension && isSupportedExtension(filenameExtension)) {
    return filenameExtension
  }

  const mimeExtension = mimeType ? getExtensionFromMimeType(mimeType) : undefined

  // A retired format is refused by name, before the mime and plain-text
  // fallbacks could hand its bytes to a parser that would read them as text.
  for (const candidate of [filenameExtension, mimeExtension]) {
    const reason = candidate ? retiredExtensionReason(candidate) : undefined
    if (candidate && reason) {
      throw new Error(`Unsupported file type: ${candidate} (${reason})`)
    }
  }
  if (mimeExtension && isSupportedExtension(mimeExtension)) {
    return mimeExtension
  }

  if (fallback) {
    return fallback
  }

  if (filenameExtension) {
    throw new Error(
      `Unsupported file type: ${filenameExtension}. Supported types are: ${SUPPORTED_EXTENSIONS_TEXT}`
    )
  }

  throw new Error(`Could not determine file type for ${filename || 'document'}`)
}
