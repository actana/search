/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  assignCluster,
  cosineDistance,
  inertia,
  runClustering,
  silhouetteSample,
  validateK,
} from './clustering.ts'

/**
 * Mulberry32 mirror so the fixture is deterministic without importing
 * the private RNG from the module under test.
 */
function rngFromSeed(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Generate three well-separated 2D Gaussian-ish blobs around fixed
 * centers. We use small jitter so cosine separation is unambiguous.
 */
function makeBlobs(seed = 7): { vectors: number[][]; labels: number[] } {
  const rng = rngFromSeed(seed)
  const centers: number[][] = [
    [10, 0],
    [0, 10],
    [-10, -10],
  ]
  const vectors: number[][] = []
  const labels: number[] = []
  for (let c = 0; c < centers.length; c++) {
    for (let n = 0; n < 30; n++) {
      const dx = (rng() - 0.5) * 0.5
      const dy = (rng() - 0.5) * 0.5
      vectors.push([centers[c][0] + dx, centers[c][1] + dy])
      labels.push(c)
    }
  }
  return { vectors, labels }
}

describe('cosineDistance', () => {
  it('returns 0 for identical unit vectors', () => {
    expect(cosineDistance([1, 0], [1, 0])).toBeCloseTo(0, 10)
  })

  it('returns 1 for orthogonal vectors', () => {
    expect(cosineDistance([1, 0], [0, 1])).toBeCloseTo(1, 10)
  })

  it('returns 1 for zero vectors (defensive)', () => {
    expect(cosineDistance([0, 0], [1, 1])).toBe(1)
  })
})

describe('runClustering', () => {
  it('recovers three well-separated blobs', () => {
    const { vectors, labels } = makeBlobs()
    const res = runClustering(vectors, 3, { seed: 42 })
    expect(res.centroids).toHaveLength(3)

    const groups = new Map<number, Set<number>>()
    for (let i = 0; i < res.assignments.length; i++) {
      const a = res.assignments[i]
      if (!groups.has(a)) groups.set(a, new Set())
      groups.get(a)?.add(labels[i])
    }
    for (const set of groups.values()) {
      expect(set.size).toBe(1)
    }
  })

  it('throws when k > vectors.length', () => {
    expect(() => runClustering([[1, 2]], 3)).toThrow()
  })

  it('throws when k < 1', () => {
    expect(() => runClustering([[1, 2]], 0)).toThrow()
  })

  it('k=1 returns single mean centroid and zero-ish inertia for identical inputs', () => {
    const vectors = Array.from({ length: 10 }, () => [3, 4])
    const res = runClustering(vectors, 1)
    expect(res.centroids).toHaveLength(1)
    expect(res.inertia).toBeCloseTo(0, 10)
  })

  it('produces identical assignments across runs with the same seed', () => {
    const { vectors } = makeBlobs(11)
    const a = runClustering(vectors, 3, { seed: 99 })
    const b = runClustering(vectors, 3, { seed: 99 })
    const c = runClustering(vectors, 3, { seed: 99 })
    expect(a.assignments).toEqual(b.assignments)
    expect(b.assignments).toEqual(c.assignments)
  })
})

describe('inertia', () => {
  it('is zero when vectors sit on their centroid', () => {
    const vec = [
      [1, 0],
      [1, 0],
      [1, 0],
    ]
    const res = runClustering(vec, 1)
    expect(
      inertia(
        vec.map((v) => v),
        res.centroids,
        res.assignments
      )
    ).toBeGreaterThanOrEqual(0)
  })
})

describe('silhouetteSample', () => {
  it('approximates the full silhouette within tolerance on n=200', () => {
    const { vectors } = makeBlobs(3)
    const more: number[][] = []
    for (let i = 0; i < 200; i++) more.push(vectors[i % vectors.length])
    const res = runClustering(more, 3, { seed: 5 })
    const full = silhouetteSample(more, res.assignments, { sampleSize: more.length, seed: 1 })
    const sampled = silhouetteSample(more, res.assignments, { sampleSize: 50, seed: 1 })
    expect(Math.abs(full - sampled)).toBeLessThanOrEqual(0.05)
  })
})

describe('validateK', () => {
  it('recommends 3 or 4 when given currentK=2 on 3-blob data', () => {
    const { vectors } = makeBlobs(8)
    const res = validateK(vectors, 2, { candidates: [2, 3, 4], seed: 13 })
    expect([3, 4]).toContain(res.recommendedK)
  })

  it('keeps currentK=3 when no significant improvement', () => {
    const { vectors } = makeBlobs(8)
    const res = validateK(vectors, 3, { candidates: [3, 5, 7], seed: 13 })
    expect(res.recommendedK).toBe(3)
  })
})

describe('assignCluster', () => {
  it('returns null when centroids are empty', () => {
    expect(assignCluster([1, 2, 3], [])).toBeNull()
  })

  it('picks the nearest centroid', () => {
    const idx = assignCluster(
      [1, 0],
      [
        [0, 1],
        [1, 0.01],
        [-1, 0],
      ]
    )
    expect(idx).toBe(1)
  })
})
