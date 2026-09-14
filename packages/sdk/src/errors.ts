/**
 * The one error every route in this SDK throws.
 *
 * `code` is the instance's own machine-readable reason — the fixed enum
 * TASK-004 pins down in `contracts/` — and it is what a caller switches on.
 * `status` and `detail` are for a human reading a log. The message is for
 * neither: do not parse it.
 */
export class SearchApiError extends Error {
  override readonly name = "SearchApiError";
  /** The instance's `code`, e.g. `not-found`, `forbidden`, `core-error`. */
  readonly code: string;
  /** The HTTP status it arrived with. `0` when the request never got one. */
  readonly status: number;
  /** Whatever else the body carried. */
  readonly detail: unknown;

  // Fields are assigned rather than declared as constructor parameters: this
  // package is loaded by plain `node` with type stripping only, which cannot
  // erase a parameter property.
  constructor(
    code: string,
    status: number,
    message: string,
    detail: unknown = undefined,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}
