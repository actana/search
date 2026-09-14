/**
 * Race `promise` against a deadline. On timeout the returned promise rejects
 * with an Error carrying `message`; the underlying work may still settle later
 * (a race cannot preempt synchronous work). The timer is always cleared so a
 * fast resolution cannot leave a dangling timeout keeping the process alive.
 */
export async function withPromiseTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
