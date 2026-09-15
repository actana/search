/**
 * What "there is no key for this endpoint right now" is, as a type — and the
 * two functions that keep the key out of the report.
 *
 * In wired mode a provider key is fetched from the paired client's resolver for
 * the life of one job (ADR 0004). That call can fail in half a dozen ways that
 * are *not* the document's fault: the client is restarting, its resolver is
 * behind a load balancer that just dropped, the internal key was rotated an
 * hour ago. Every one of them is temporary, and every one of them would, as a
 * plain `Error`, look exactly like "this PDF cannot be parsed" to the worker —
 * which retries it three times and then marks the document `failed` forever.
 *
 * So the failure has a name. {@link EndpointKeyUnavailableError} is what the
 * worker switches on to decide *retry the job* rather than *fail the document*
 * (ADR 0010), and `retryable` is the one bit that decision reads.
 *
 * **Nothing in here ever carries the key.** Two rules, belt and braces:
 *
 *   1. The resolver client never interpolates a response body into a message.
 *      A message names a status code, a URL's origin and a reason, and nothing
 *      that was in the body.
 *   2. {@link scrubSecret} is run over anything thrown from the region where a
 *      key *was* in hand, rewriting `message` and `stack`. Rule 1 is what makes
 *      it a no-op; rule 2 is what makes that testable rather than asserted.
 */

/** What replaces a secret that got somewhere it should not have. */
export const REDACTED = '[redacted]'

/** Why a key could not be produced. Each one is a different operator action. */
export type EndpointKeyUnavailableReason =
  /** The paired client never declared a mirrored source, so there is nothing to ask. */
  | 'not-configured'
  /** The row is mirrored but carries no `external_id` — a bad push. */
  | 'not-mirrored'
  /** The resolver answered 404: it does not know that endpoint any more. */
  | 'unknown-endpoint'
  /** The resolver answered 401/403: Search's `x-api-key` is not (or no longer) good. */
  | 'unauthorized'
  /** The resolver answered 5xx. */
  | 'resolver-error'
  /** The resolver did not answer inside the timeout. */
  | 'timeout'
  /** The resolver could not be reached at all. */
  | 'unreachable'
  /** A 200 that was not a resolution — no `apiKey`, not JSON, or too big. */
  | 'malformed'
  /**
   * The resolver URL is not one this instance may fetch. The SSRF guard
   * (`core/security/url-guard.ts`) refused it: loopback, a private or reserved
   * address, a blocked port, a non-http(s) scheme — or the resolver answered
   * with a redirect, which is never followed.
   */
  | 'refused'
  /**
   * The sealed resolver credential could not be opened.
   * `SEARCH_ENCRYPTION_KEY` is absent, is not the key the declaration was
   * sealed with, or has been rotated without re-sealing (ADR 0010 D7).
   */
  | 'decrypt-failed'
  /**
   * The resolver answered naming a different model or provider than the mirror
   * row declares. A KB's partition is sized to *its* model's dimension, so
   * quietly embedding with another model is a corrupted index rather than a
   * slow day (ADR 0005: behaviour is what the client declared).
   */
  | 'model-mismatch'
  /** The endpoint row belongs to a paired client other than the caller's. */
  | 'client-mismatch'

/**
 * Reasons a retry cannot fix. An endpoint the client has forgotten is not
 * coming back on the fourth attempt, and neither is a push that carried no
 * external id — both are the *configuration* being wrong, which is the one
 * shape of this failure that should reach the document.
 *
 * The last four are the same kind of fact. A refused URL, a credential that
 * will not decrypt, a resolver naming another model and a row belonging to
 * another client are all decisions rather than weather: the fifth attempt is
 * told exactly the same thing, and the worker turns them into BullMQ's
 * `UnrecoverableError` rather than spending the job's attempts on them
 * (ADR 0010 D3, D4).
 */
const TERMINAL_REASONS = new Set<EndpointKeyUnavailableReason>([
  'not-configured',
  'not-mirrored',
  'unknown-endpoint',
  'refused',
  'decrypt-failed',
  'model-mismatch',
  'client-mismatch',
])

export interface EndpointKeyUnavailableInit {
  reason: EndpointKeyUnavailableReason
  /** Search's own id for the endpoint row. */
  endpointId?: string | null
  /** The paired client's id for it — what the resolver was asked about. */
  externalId?: string | null
  pairedClientId?: string | null
  /** The HTTP status the resolver answered with, when there was one. */
  status?: number | null
  cause?: unknown
}

/**
 * A provider key could not be resolved. Thrown by `MirroredEndpointSource` and
 * caught by the worker, which turns it into a clean retry (ADR 0010).
 */
export class EndpointKeyUnavailableError extends Error {
  override readonly name = 'EndpointKeyUnavailableError'
  readonly reason: EndpointKeyUnavailableReason
  readonly endpointId: string | null
  readonly externalId: string | null
  readonly pairedClientId: string | null
  readonly status: number | null
  /** Whether trying again later could work. The worker's whole decision. */
  readonly retryable: boolean

  // Fields assigned in the body, not declared as constructor parameters: this
  // repository is run by Node's type stripping, which cannot erase a parameter
  // property (`scripts/check-strip-types.mjs`).
  constructor(message: string, init: EndpointKeyUnavailableInit) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause })
    this.reason = init.reason
    this.endpointId = init.endpointId ?? null
    this.externalId = init.externalId ?? null
    this.pairedClientId = init.pairedClientId ?? null
    this.status = init.status ?? null
    this.retryable = !TERMINAL_REASONS.has(init.reason)
  }
}

/** Narrow an unknown catch. */
export function isEndpointKeyUnavailable(err: unknown): err is EndpointKeyUnavailableError {
  return err instanceof EndpointKeyUnavailableError
}

/**
 * Replace every occurrence of `secret` in `text`.
 *
 * A blank or very short secret is left alone: replacing every `a` in a message
 * because a misconfigured endpoint stored a one-character key would destroy the
 * message without protecting anything.
 */
export function redactSecret(text: string, secret: string | null | undefined): string {
  if (!secret || secret.length < 8) return text
  return text.split(secret).join(REDACTED)
}

/**
 * Rewrite an error's `message` and `stack` so neither carries `secret`, and
 * hand the same error back.
 *
 * The properties are reassigned rather than the error rebuilt: a caller that
 * catches this may be checking `instanceof`, and a rebuilt error is a different
 * class with a different prototype. `stack` is writable on a V8 error, and a
 * host object where it is not simply keeps the stack it had — which is why the
 * message is scrubbed first and independently.
 */
export function scrubSecret<T>(err: T, secret: string | null | undefined): T {
  if (!secret || secret.length < 8) return err
  if (!(err instanceof Error)) return err
  try {
    err.message = redactSecret(err.message, secret)
  } catch {
    /* a frozen error is one we cannot improve; the throw still matters */
  }
  try {
    if (typeof err.stack === 'string') err.stack = redactSecret(err.stack, secret)
  } catch {
    /* as above */
  }
  return err
}
