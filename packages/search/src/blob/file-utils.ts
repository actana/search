/**
 * Blob key and URL handling. Lifted from Studio's
 * `lib/uploads/utils/file-utils.ts`, trimmed to the four helpers the engine
 * calls.
 *
 * lifted: the storage-context vocabulary collapsed from thirteen values to one.
 * Studio's bucket is shared by chat, execution, profile pictures and nine other
 * things, so a key had to say which it was. Search's bucket holds knowledge-base
 * documents and nothing else (ADR 0006), so `inferContextFromKey` — and the
 * error it threw for an unprefixed key — had nothing left to decide.
 */

/** The only storage context Search has. Kept as a type so the lifted call sites read unchanged. */
export type StorageContext = 'knowledge-base'

const MIME_TO_EXTENSION: Record<string, string> = {
  // Documents
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/json': 'json',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'text/html': 'html',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/msword': 'doc',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'text/markdown': 'md',
  'application/rtf': 'rtf',
  'application/x-yaml': 'yaml',
  'text/yaml': 'yaml',
}

/**
 * Get file extension from MIME type.
 * @returns File extension without dot, or null if not found
 */
export function getExtensionFromMimeType(mimeType: string): string | null {
  return MIME_TO_EXTENSION[mimeType.toLowerCase()] || null
}

/** Serve prefix for a blob Search holds. */
export const SERVE_PATH_PREFIX = '/api/files/serve/'

/**
 * Extract a storage key from a file path.
 * Handles URLs like `/api/files/serve/s3/key`.
 */
export function extractStorageKey(filePath: string): string {
  let pathWithoutQuery = filePath.split('?')[0]

  try {
    if (pathWithoutQuery.startsWith('http://') || pathWithoutQuery.startsWith('https://')) {
      const url = new URL(pathWithoutQuery)
      pathWithoutQuery = url.pathname
    }
  } catch {
    // If URL parsing fails, use the original path
  }

  if (pathWithoutQuery.startsWith(SERVE_PATH_PREFIX)) {
    let key = decodeURIComponent(pathWithoutQuery.substring(SERVE_PATH_PREFIX.length))
    if (key.startsWith('s3/')) {
      key = key.substring(3)
    } else if (key.startsWith('blob/')) {
      key = key.substring(5)
    }
    return key
  }
  return pathWithoutQuery
}

/** Whether a URL points at a blob this instance serves. */
export function isInternalFileUrl(fileUrl: string): boolean {
  return fileUrl.includes(SERVE_PATH_PREFIX)
}

/** Extract the storage key and context from an internal file URL. */
export function parseInternalFileUrl(fileUrl: string): { key: string; context: StorageContext } {
  const key = extractStorageKey(fileUrl)

  if (!key) {
    throw new Error('Could not extract storage key from internal file URL')
  }

  return { key, context: 'knowledge-base' }
}
