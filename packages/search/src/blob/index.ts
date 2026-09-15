/**
 * Search's blob storage. Replaces Studio's `@/lib/uploads`.
 *
 * `StorageService` is a namespace re-export, exactly as Studio's index exposed
 * it, so the lifted `StorageService.uploadFile(...)` call sites are unchanged.
 */

import * as StorageServiceImpl from './storage-service.ts'

export * as StorageService from './storage-service.ts'
export {
  deleteFile,
  downloadFile,
  generatePresignedDownloadUrl,
  hasCloudStorage,
  resetStorageClient,
  servePathFor,
  uploadFile,
  type DeleteFileOptions,
  type DownloadFileOptions,
  type FileInfo,
  type UploadFileOptions,
} from './storage-service.ts'
export {
  extractStorageKey,
  getExtensionFromMimeType,
  isInternalFileUrl,
  parseInternalFileUrl,
  SERVE_PATH_PREFIX,
  type StorageContext,
} from './file-utils.ts'
export {
  FORM_OVERHEAD_SLACK_BYTES,
  isAlphanumericExtension,
  isSupportedExtension,
  MAX_UPLOAD_SIZE_BYTES,
  requestBodyExceedsUploadCap,
  RETIRED_DOCUMENT_EXTENSIONS,
  retiredExtensionReason,
  SUPPORTED_DOCUMENT_EXTENSIONS,
  type SupportedDocumentExtension,
} from './validation.ts'

/**
 * Fetch a document's bytes, from this instance's bucket or from a URL the
 * caller supplied.
 *
 * The URL goes through the SSRF guard first (`core/security/url-guard.ts`,
 * lifted from Studio): its protocol, port and resolved address are checked, and
 * the fetch then connects to *that address* with the hostname kept for TLS SNI,
 * so a second DNS answer cannot move the connection somewhere else. A plain
 * `fetch` here would be "retrieve any URL you are handed, from inside the
 * deployment's network", which is the entire SSRF class and which SECURITY.md
 * lists as in scope.
 */
export async function downloadFileFromUrl(
  fileUrl: string,
  timeoutMs = 60_000,
  maxResponseBytes: number = 50 * 1024 * 1024
): Promise<Buffer> {
  const { isInternalFileUrl, parseInternalFileUrl } = await import('./file-utils.ts')

  if (isInternalFileUrl(fileUrl)) {
    const { key } = parseInternalFileUrl(fileUrl)
    return StorageServiceImpl.downloadFile({ key })
  }

  const { secureFetchWithPinnedIP, validateUrlWithDNS } = await import(
    '../core/security/url-guard.ts'
  )

  const validation = await validateUrlWithDNS(fileUrl, 'fileUrl')
  if (!validation.isValid) {
    throw new Error(`Invalid file URL: ${validation.error}`)
  }

  const response = await secureFetchWithPinnedIP(fileUrl, validation.resolvedIP!, {
    timeout: timeoutMs,
    maxResponseBytes,
  })

  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.statusText}`)
  }

  return Buffer.from(await response.arrayBuffer())
}
