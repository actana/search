/**
 * Hand-rolled clustering primitive (D² seeding + Lloyd iteration) operating
 * under cosine distance. No external dependencies. Deterministic when a
 * `seed` is supplied via a Mulberry32 RNG.
 *
 * Embeddings are expected to be unit-length-ish but vectors are
 * re-normalised defensively before distance calculation.
 */

/**
 * Result of a successful clustering run.
 */
export interface ClusteringResult {
  centroids: number[][]
  assignments: number[]
  inertia: number
}

/**
 * Result of `lloydIterate`, which additionally exposes the iteration count
 * (useful for tests and diagnostics).
 */
export interface LloydResult extends ClusteringResult {
  iters: number
}

/**
 * Options accepted by `runClustering` / `lloydIterate`.
 */
export interface ClusteringOptions {
  seed?: number
  maxIters?: number
  tol?: number
}

/**
 * Options for `validateK`.
 */
export interface ValidateKOptions {
  candidates?: number[]
  sampleSize?: number
  seed?: number
  maxIters?: number
  tol?: number
}

/**
 * Per-candidate scoring row returned by `validateK`.
 */
export interface ValidateKCandidate {
  k: number
  silhouette: number
  inertia: number
}

/**
 * Result of `validateK`.
 */
export interface ValidateKResult {
  recommendedK: number
  silhouette: number
  inertia: number
  candidates: ValidateKCandidate[]
}

const DEFAULT_MAX_ITERS = 50
const DEFAULT_TOL = 1e-4
const DEFAULT_SILHOUETTE_SAMPLE = 500
const SILHOUETTE_EPSILON = 0.02

/**
 * Mulberry32 — small seedable PRNG. Returns a function that yields the
 * next pseudo-random float in [0, 1). Used for deterministic seeding,
 * sampling and D² draws.
 */
function mulberry32(seed: number): () => number {
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
 * Resolve an RNG: seeded Mulberry32 when `seed` is supplied, else
 * `Math.random` so callers that don't care about determinism opt out
 * cleanly.
 */
function resolveRng(seed?: number): () => number {
  return typeof seed === 'number' ? mulberry32(seed) : Math.random
}

function norm(v: number[]): number {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i]
  return Math.sqrt(sum)
}

function normalize(v: number[]): number[] {
  const n = norm(v)
  if (n === 0) return v.slice()
  const out = new Array<number>(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n
  return out
}

function dot(a: number[], b: number[]): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/**
 * Cosine distance `1 - cos(a, b)`. Returns 1 when either vector has zero
 * magnitude. Result is clamped to [0, 2] to guard against floating-point
 * drift below zero.
 */
export function cosineDistance(a: number[], b: number[]): number {
  const na = norm(a)
  const nb = norm(b)
  if (na === 0 || nb === 0) return 1
  const cos = dot(a, b) / (na * nb)
  const d = 1 - cos
  if (d < 0) return 0
  if (d > 2) return 2
  return d
}

/**
 * D² weighted seeding. Picks the first centroid uniformly at random, then
 * each subsequent centroid with probability proportional to the squared
 * distance to the nearest already-chosen centroid.
 */
export function seedCentroids(vectors: number[][], k: number, rng: () => number): number[][] {
  if (vectors.length === 0) return []
  const centroids: number[][] = []
  const firstIdx = Math.floor(rng() * vectors.length)
  centroids.push(vectors[firstIdx].slice())

  const closestSq = new Array<number>(vectors.length).fill(Number.POSITIVE_INFINITY)
  for (let i = 0; i < vectors.length; i++) {
    const d = cosineDistance(vectors[i], centroids[0])
    closestSq[i] = d * d
  }

  while (centroids.length < k) {
    let total = 0
    for (let i = 0; i < closestSq.length; i++) total += closestSq[i]
    let pickIdx = vectors.length - 1
    if (total > 0) {
      let r = rng() * total
      for (let i = 0; i < closestSq.length; i++) {
        r -= closestSq[i]
        if (r <= 0) {
          pickIdx = i
          break
        }
      }
    } else {
      pickIdx = Math.floor(rng() * vectors.length)
    }
    const chosen = vectors[pickIdx].slice()
    centroids.push(chosen)
    for (let i = 0; i < vectors.length; i++) {
      const d = cosineDistance(vectors[i], chosen)
      const dsq = d * d
      if (dsq < closestSq[i]) closestSq[i] = dsq
    }
  }

  return centroids
}

function meanCentroid(members: number[][], dim: number): number[] {
  const acc = new Array<number>(dim).fill(0)
  for (const m of members) {
    for (let j = 0; j < dim; j++) acc[j] += m[j]
  }
  for (let j = 0; j < dim; j++) acc[j] /= members.length
  return normalize(acc)
}

/**
 * Standard Lloyd iteration under cosine distance. Each pass assigns
 * vectors to the nearest centroid, then recomputes centroids as the
 * (re-normalised) mean of their members. Early-exits when the maximum
 * centroid shift is below `tol`.
 */
export function lloydIterate(
  vectors: number[][],
  centroids: number[][],
  opts?: { maxIters?: number; tol?: number }
): LloydResult {
  const maxIters = opts?.maxIters ?? DEFAULT_MAX_ITERS
  const tol = opts?.tol ?? DEFAULT_TOL
  const dim = vectors[0]?.length ?? 0
  let current = centroids.map((c) => c.slice())
  const assignments = new Array<number>(vectors.length).fill(0)
  let iters = 0
  let lastInertia = 0

  for (let iter = 0; iter < maxIters; iter++) {
    iters = iter + 1
    lastInertia = 0
    for (let i = 0; i < vectors.length; i++) {
      let best = 0
      let bestD = cosineDistance(vectors[i], current[0])
      for (let c = 1; c < current.length; c++) {
        const d = cosineDistance(vectors[i], current[c])
        if (d < bestD) {
          bestD = d
          best = c
        }
      }
      assignments[i] = best
      lastInertia += bestD * bestD
    }

    const buckets: number[][][] = current.map(() => [])
    for (let i = 0; i < vectors.length; i++) {
      buckets[assignments[i]].push(vectors[i])
    }

    const next: number[][] = new Array(current.length)
    let maxShift = 0
    for (let c = 0; c < current.length; c++) {
      if (buckets[c].length === 0) {
        next[c] = current[c].slice()
        continue
      }
      next[c] = meanCentroid(buckets[c], dim)
      const shift = cosineDistance(current[c], next[c])
      if (shift > maxShift) maxShift = shift
    }

    current = next
    if (maxShift < tol) break
  }

  return { centroids: current, assignments, inertia: lastInertia, iters }
}

/**
 * Run clustering: validates `k`, normalises inputs once, seeds via D²
 * weighting, then runs Lloyd iteration.
 *
 * @throws when `k < 1` or `k > vectors.length`.
 */
export function runClustering(
  vectors: number[][],
  k: number,
  opts?: ClusteringOptions
): ClusteringResult {
  if (k < 1) throw new Error(`runClustering: k must be >= 1 (got ${k})`)
  if (k > vectors.length) {
    throw new Error(`runClustering: k (${k}) must not exceed vectors.length (${vectors.length})`)
  }

  const normalised = vectors.map((v) => normalize(v))

  if (k === 1) {
    const dim = normalised[0]?.length ?? 0
    const centroid = meanCentroid(normalised, dim)
    const assignments = new Array<number>(normalised.length).fill(0)
    let inertiaSum = 0
    for (const v of normalised) {
      const d = cosineDistance(v, centroid)
      inertiaSum += d * d
    }
    return { centroids: [centroid], assignments, inertia: inertiaSum }
  }

  const rng = resolveRng(opts?.seed)
  const seeds = seedCentroids(normalised, k, rng)
  const out = lloydIterate(normalised, seeds, { maxIters: opts?.maxIters, tol: opts?.tol })
  return { centroids: out.centroids, assignments: out.assignments, inertia: out.inertia }
}

/**
 * Within-cluster sum of squared cosine distances. Useful as an elbow
 * metric.
 */
export function inertia(vectors: number[][], centroids: number[][], assignments: number[]): number {
  let sum = 0
  for (let i = 0; i < vectors.length; i++) {
    const d = cosineDistance(vectors[i], centroids[assignments[i]])
    sum += d * d
  }
  return sum
}

/**
 * Sample-based silhouette in [-1, 1]. Full silhouette is O(n²) and too
 * slow above ~10k vectors; this samples `sampleSize` points uniformly
 * without replacement and computes a(i) and b(i) against the full
 * dataset. Returns 0 for degenerate cases (single cluster, empty input).
 */
export function silhouetteSample(
  vectors: number[][],
  assignments: number[],
  opts?: { sampleSize?: number; seed?: number }
): number {
  const n = vectors.length
  if (n === 0) return 0
  const sampleSize = Math.min(opts?.sampleSize ?? DEFAULT_SILHOUETTE_SAMPLE, n)
  const rng = resolveRng(opts?.seed)

  const indices = new Array<number>(n)
  for (let i = 0; i < n; i++) indices[i] = i
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = indices[i]
    indices[i] = indices[j]
    indices[j] = tmp
  }
  const sample = indices.slice(0, sampleSize)

  const clusterMembers = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const c = assignments[i]
    const arr = clusterMembers.get(c)
    if (arr) arr.push(i)
    else clusterMembers.set(c, [i])
  }

  if (clusterMembers.size < 2) return 0

  let total = 0
  let counted = 0
  for (const i of sample) {
    const own = assignments[i]
    const ownMembers = clusterMembers.get(own) ?? []
    if (ownMembers.length <= 1) continue

    let aSum = 0
    for (const j of ownMembers) {
      if (j === i) continue
      aSum += cosineDistance(vectors[i], vectors[j])
    }
    const a = aSum / (ownMembers.length - 1)

    let b = Number.POSITIVE_INFINITY
    for (const [cluster, members] of clusterMembers.entries()) {
      if (cluster === own || members.length === 0) continue
      let bSum = 0
      for (const j of members) bSum += cosineDistance(vectors[i], vectors[j])
      const bMean = bSum / members.length
      if (bMean < b) b = bMean
    }

    const denom = Math.max(a, b)
    if (denom === 0) continue
    total += (b - a) / denom
    counted++
  }

  return counted === 0 ? 0 : total / counted
}

/**
 * Compare `currentK` against a small set of candidate ks, scoring each
 * by silhouette. Returns the best k by silhouette; only swaps the
 * recommendation away from `currentK` when the improvement is at least
 * `SILHOUETTE_EPSILON` (0.02). Ties resolve to the smaller k.
 *
 * Candidates default to `[currentK, currentK+2, currentK+4]` and are
 * filtered to `1 <= k <= vectors.length`.
 */
export function validateK(
  vectors: number[][],
  currentK: number,
  opts?: ValidateKOptions
): ValidateKResult {
  const rawCandidates = opts?.candidates ?? [currentK, currentK + 2, currentK + 4]
  const candidates = Array.from(new Set(rawCandidates))
    .filter((k) => k >= 1 && k <= vectors.length)
    .sort((a, b) => a - b)

  const scored: ValidateKCandidate[] = []
  for (const k of candidates) {
    const res = runClustering(vectors, k, {
      seed: opts?.seed,
      maxIters: opts?.maxIters,
      tol: opts?.tol,
    })
    const sil = silhouetteSample(
      vectors.map((v) => normalize(v)),
      res.assignments,
      {
        sampleSize: opts?.sampleSize,
        seed: opts?.seed,
      }
    )
    scored.push({ k, silhouette: sil, inertia: res.inertia })
  }

  const currentEntry = scored.find((c) => c.k === currentK) ?? {
    k: currentK,
    silhouette: Number.NEGATIVE_INFINITY,
    inertia: 0,
  }

  let best = currentEntry
  for (const c of scored) {
    if (c.k === currentK) continue
    const improves = c.silhouette - currentEntry.silhouette >= SILHOUETTE_EPSILON
    if (!improves) continue
    if (c.silhouette > best.silhouette || (c.silhouette === best.silhouette && c.k < best.k)) {
      best = c
    }
  }

  return {
    recommendedK: best.k,
    silhouette: best.silhouette,
    inertia: best.inertia,
    candidates: scored,
  }
}

/**
 * Assign a single vector to the nearest centroid by cosine distance.
 * Returns `null` when `centroids` is empty (cold-start sentinel for
 * ingest cluster assignment).
 */
export function assignCluster(vector: number[], centroids: number[][]): number | null {
  if (centroids.length === 0) return null
  let best = 0
  let bestD = cosineDistance(vector, centroids[0])
  for (let c = 1; c < centroids.length; c++) {
    const d = cosineDistance(vector, centroids[c])
    if (d < bestD) {
      bestD = d
      best = c
    }
  }
  return best
}
