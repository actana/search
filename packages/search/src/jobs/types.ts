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
