/**
 * The S3-compatible bucket Search owns (ADR 0006).
 *
 * Replaces Studio's `lib/uploads/core/storage-service.ts`. The call surface the
 * engine uses is the same — `uploadFile`, `downloadFile`, `deleteFile`,
 * `generatePresignedDownloadUrl` — so the lifted document processor and
 * document service read unchanged.
 *
 * lifted: Studio's provider abstraction (S3 *or* Azure Blob, chosen per storage
 * context by `USE_BLOB_STORAGE` / `USE_S3_STORAGE`) is one provider here.
 * Search's bucket is S3-compatible by configuration — MinIO in the reference
 * stack — and a second provider is a decision with an ADR, not a branch that
 * arrives with a lift.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { createLogger } from '@actana/search-shared/log'
import { config } from '../config.ts'
import type { StorageContext } from './file-utils.ts'
import { SERVE_PATH_PREFIX } from './file-utils.ts'

const logger = createLogger('blob/storage-service')

export interface FileInfo {
  path: string
  key: string
  name: string
  size: number
  type: string
}

export interface UploadFileOptions {
  file: Buffer
  fileName: string
  contentType: string
  size?: number
  context?: StorageContext
  /** Caller-chosen key, used by the OCR path so a re-upload is idempotent. */
  customKey?: string
  metadata?: Record<string, string>
}

export interface DownloadFileOptions {
  key: string
  context?: StorageContext
}

export interface DeleteFileOptions {
  key: string
  context?: StorageContext
}

let cachedClient: S3Client | undefined

function client(): S3Client {
  if (cachedClient) return cachedClient
  const cfg = config()
  cachedClient = new S3Client({
    region: cfg.SEARCH_S3_REGION,
    endpoint: cfg.SEARCH_S3_ENDPOINT,
    forcePathStyle: cfg.SEARCH_S3_FORCE_PATH_STYLE,
    credentials:
      cfg.SEARCH_S3_ACCESS_KEY && cfg.SEARCH_S3_SECRET_KEY
        ? {
            accessKeyId: cfg.SEARCH_S3_ACCESS_KEY,
            secretAccessKey: cfg.SEARCH_S3_SECRET_KEY,
          }
        : undefined,
  })
  return cachedClient
}

function bucket(): string {
  return config().SEARCH_S3_BUCKET
}

/** Drop the memoised client. Tests that change the configuration call this. */
export function resetStorageClient(): void {
  cachedClient = undefined
}

/**
 * Key layout: `kb/<timestamp>-<random>-<sanitised name>`. The `kb/` prefix is
 * kept from Studio so a migrated object needs no rename.
 */
function storageKeyFor(fileName: string): string {
  const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120)
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  return `kb/${unique}-${safe}`
}

/** The path a client fetches a blob back through. Resolved by the API layer. */
export function servePathFor(key: string): string {
  return `${SERVE_PATH_PREFIX}s3/${encodeURIComponent(key)}`
}

export async function uploadFile(options: UploadFileOptions): Promise<FileInfo> {
  const key = options.customKey ?? storageKeyFor(options.fileName)
  const size = options.size ?? options.file.length

  await client().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: options.file,
      ContentType: options.contentType,
      Metadata: options.metadata,
    })
  )

  logger.info('Uploaded blob', { key, size, contentType: options.contentType })

  return {
    path: servePathFor(key),
    key,
    name: options.fileName,
    size,
    type: options.contentType,
  }
}

export async function downloadFile(options: DownloadFileOptions): Promise<Buffer> {
  const result = await client().send(
    new GetObjectCommand({ Bucket: bucket(), Key: options.key })
  )
  if (!result.Body) {
    throw new Error(`Blob has no body: ${options.key}`)
  }
  const bytes = await result.Body.transformToByteArray()
  return Buffer.from(bytes)
}

export async function deleteFile(options: DeleteFileOptions): Promise<void> {
  await client().send(new DeleteObjectCommand({ Bucket: bucket(), Key: options.key }))
  logger.info('Deleted blob', { key: options.key })
}

/**
 * A time-limited URL a model provider can fetch the object through. Used where
 * an external parser needs the bytes and cannot be handed a buffer.
 */
export async function generatePresignedDownloadUrl(
  key: string,
  _context?: StorageContext,
  expiresInSeconds = 900
): Promise<string> {
  return getSignedUrl(client(), new GetObjectCommand({ Bucket: bucket(), Key: key }), {
    expiresIn: expiresInSeconds,
  })
}

/** Whether a bucket is configured at all. */
export function hasCloudStorage(): boolean {
  const cfg = config()
  return Boolean(cfg.SEARCH_S3_ENDPOINT || cfg.SEARCH_S3_ACCESS_KEY)
}
