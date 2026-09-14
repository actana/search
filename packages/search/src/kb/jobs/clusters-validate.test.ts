/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// lifted: these four were plain `const`s, which the `vi.mock` factory below
// closes over — and `vi.mock` is hoisted above them, so the factory ran before
// they were initialised. It is red on Studio's base for exactly this reason
// (verified 2026-09-14). `vi.hoisted` is the one-line fix: the bindings move up
// with the factory. No behaviour, and no assertion, changed.
const { deleteWhere, insertValues, updateMock } = vi.hoisted(() => {
  const updateSet = vi.fn(() => ({ where: vi.fn(async () => undefined) }))
  return {
    updateSet,
    updateMock: vi.fn(() => ({ set: updateSet })),
    deleteWhere: vi.fn(async () => undefined),
    insertValues: vi.fn(async () => undefined),
  }
})

vi.mock('../../db/client.ts', () => {
  const tx = {
    delete: vi.fn(() => ({ where: deleteWhere })),
    insert: vi.fn(() => ({ values: insertValues })),
    update: updateMock,
    execute: vi.fn(async () => ({ rows: [] })),
  }
  return {
    db: {
      select: vi.fn(),
      execute: vi.fn(async () => ({ rows: [] })),
      update: updateMock,
      transaction: vi.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)),
    },
  }
})

vi.mock('@actana/search-shared/log', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

const validateKMock = vi.fn()
const runClusteringMock = vi.fn()
vi.mock('../clustering.ts', () => ({
  validateK: (...a: unknown[]) => validateKMock(...a),
  runClustering: (...a: unknown[]) => runClusteringMock(...a),
}))

import { db } from '../../db/client.ts'
import { clustersValidateJobName, handleClustersValidate } from './clusters-validate.ts'

function mockKb() {
  ;(db.select as ReturnType<typeof vi.fn>).mockImplementation(() => ({
    from: () => ({ where: () => ({ limit: async () => [{ id: 'kb-1', kmeansK: 3 }] }) }),
  }))
}

describe('handleClustersValidate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('exports canonical job name', () => {
    expect(clustersValidateJobName).toBe('kb.clusters.validate')
  })

  it('only bumps timestamp when k is unchanged', async () => {
    mockKb()
    ;(db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      rows: [{ id: 'a', embedding: '[1,2,3]' }],
    })
    // lifted: a second `mockResolvedValueOnce({ rows: [] })` stood here. The
    // streaming loop breaks on a short page, so it was never consumed — and a
    // queued-but-unused `once` survives `vi.clearAllMocks()` into the next test,
    // where it answered the partition query with no rows and made the refit
    // case skip. Invisible on Studio's base, where this file never loaded at
    // all (a `vi.mock` hoisting error, fixed above).
    validateKMock.mockReturnValue({ recommendedK: 3, silhouette: 0.4, inertia: 1, candidates: [] })
    await handleClustersValidate({ kbId: 'kb-1' })
    expect(runClusteringMock).not.toHaveBeenCalled()
    expect(updateMock).toHaveBeenCalled()
  })

  it('refits and rewrites when k changes', async () => {
    mockKb()
    ;(db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      rows: [
        { id: 'a', embedding: '[1,0,0]' },
        { id: 'b', embedding: '[0,1,0]' },
      ],
    })
    ;(db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [] })
    validateKMock.mockReturnValue({ recommendedK: 5, silhouette: 0.6, inertia: 1, candidates: [] })
    runClusteringMock.mockReturnValue({
      centroids: [
        [1, 0, 0],
        [0, 1, 0],
      ],
      assignments: [0, 1],
      inertia: 0,
    })
    await handleClustersValidate({ kbId: 'kb-1' })
    expect(runClusteringMock).toHaveBeenCalled()
  })
})
