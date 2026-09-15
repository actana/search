/**
 * The job payloads the ingestion pipeline enqueues.
 *
 * lifted: `DocumentProcessingPayload` came from Studio's
 * `background/knowledge-processing.ts`, which is that repo's job-trigger module
 * — it also carried the Next.js runtime plumbing (`withJobLogContext`, the
 * execution correlation record that ties a job to a workflow run) that Search
 * has nothing to do with. The payload itself is the engine's, so it moved here;
 * the two Studio-shaped fields went:
 *
 *   - `correlation?: Partial<AsyncExecutionCorrelation>` — a workflow execution
 *     id, a trigger type, a schedule id. Search does not know what a workflow
 *     is (ADR 0006).
 *   - `metadata?: { runtime?: JobRuntime }` — which Studio process picked the
 *     job up. Search has one worker.
 */

/**
 * The `kb.ingest.document` payload, as TASK-004's routes enqueue it and as
 * `kb/ingest.ts`'s `ingestDocument` destructures it — the field names, spelled
 * out because they are the thing that has to agree:
 * `kbId` (**not** `knowledgeBaseId`), `documentId`, `text` (the direct-text
 * path; a file-backed document takes {@link DocumentProcessingPayload}
 * instead), `filename`, `mimeType`, `metadata`, `includedInKb`, and `tags`
 * already coerced to the column types.
 *
 * **TASK-005's worker declares a different shape for the same job name, and the
 * rebase aligns it to this one** rather than the other way round: this is the
 * shape the frozen `ingestDocument` actually reads, and it is the shape any
 * payload already sitting in Redis is written in.
 */
export type KbIngestDocumentPayload = {
  kbId: string
  documentId: string
  text?: string
  filename: string
  mimeType?: string
  metadata?: Record<string, unknown>
  includedInKb?: boolean
  tags?: Record<string, string | number | boolean | Date | null>
}

export type DocumentProcessingPayload = {
  knowledgeBaseId: string
  documentId: string
  docData: {
    filename: string
    fileUrl: string
    fileSize: number
    mimeType: string
  }
  processingOptions: {
    recipe?: string
    lang?: string
  }
  requestId: string
  jobId?: string
  attempt?: number
}
