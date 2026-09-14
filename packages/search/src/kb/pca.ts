/**
 * Lightweight 2-component PCA via power iteration with deflation.
 *
 * Used to project KB partition embeddings into 2D for the Clusters tab
 * scatter plot. Power iteration on the (D × D) covariance matrix is
 * impractical for D≈1536 — instead we work in vector space directly
 * using the Gram-style trick: for unit-mean-centred vectors x_i ∈ R^D
 * with N vectors, the top principal direction equals the eigenvector of
 * the D×D covariance C = (1/N) Σ x_i x_iᵀ. Power iteration repeatedly
 * applies C to a candidate vector v:
 *
 *   v ← (1/N) Σ x_i (x_iᵀ v)
 *
 * Each iteration is O(N·D) — much cheaper than materialising C.
 * After convergence we project all vectors onto v to get the first
 * component, deflate, then repeat to get the second component.
 *
 * Inputs are NOT assumed normalised; the routine centres on the mean.
 */

export interface PcaProjectionOptions {
  iters?: number
  tol?: number
}

const DEFAULT_ITERS = 30
const DEFAULT_TOL = 1e-5

function center(vectors: number[][]): { centered: number[][]; mean: number[] } {
  const n = vectors.length
  const dim = vectors[0]?.length ?? 0
  const mean = new Array<number>(dim).fill(0)
  for (const v of vectors) {
    for (let j = 0; j < dim; j++) mean[j] += v[j]
  }
  for (let j = 0; j < dim; j++) mean[j] /= n
  const centered = vectors.map((v) => {
    const out = new Array<number>(dim)
    for (let j = 0; j < dim; j++) out[j] = v[j] - mean[j]
    return out
  })
  return { centered, mean }
}

function norm(v: number[]): number {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i] * v[i]
  return Math.sqrt(s)
}

function normalize(v: number[]): number[] {
  const n = norm(v)
  if (n === 0) return v.slice()
  const out = new Array<number>(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n
  return out
}

/**
 * Power iteration to find the top eigenvector of (1/N) Σ x_i x_iᵀ.
 * Seeded from the first centred vector for determinism.
 */
function topComponent(centered: number[][], opts?: PcaProjectionOptions): number[] {
  const iters = opts?.iters ?? DEFAULT_ITERS
  const tol = opts?.tol ?? DEFAULT_TOL
  const dim = centered[0]?.length ?? 0
  const n = centered.length

  let v = centered[0].slice()
  if (norm(v) === 0) {
    v = new Array<number>(dim).fill(0)
    v[0] = 1
  }
  v = normalize(v)

  for (let iter = 0; iter < iters; iter++) {
    const next = new Array<number>(dim).fill(0)
    for (let i = 0; i < n; i++) {
      const x = centered[i]
      let dot = 0
      for (let j = 0; j < dim; j++) dot += x[j] * v[j]
      for (let j = 0; j < dim; j++) next[j] += x[j] * dot
    }
    const normalized = normalize(next)
    let shift = 0
    for (let j = 0; j < dim; j++) shift += (normalized[j] - v[j]) ** 2
    v = normalized
    if (Math.sqrt(shift) < tol) break
  }

  return v
}

/**
 * Project vectors to 2D via PCA. Returns one `[x, y]` per input vector.
 * For inputs with fewer than 2 dimensions of variance, the second axis
 * collapses to zero — callers should treat that as a degenerate case.
 */
export function project2D(
  vectors: number[][],
  opts?: PcaProjectionOptions
): Array<[number, number]> {
  if (vectors.length === 0) return []
  const dim = vectors[0].length
  if (dim === 0) return vectors.map(() => [0, 0])

  const { centered } = center(vectors)
  const v1 = topComponent(centered, opts)

  const deflated = centered.map((x) => {
    let dot = 0
    for (let j = 0; j < dim; j++) dot += x[j] * v1[j]
    const out = new Array<number>(dim)
    for (let j = 0; j < dim; j++) out[j] = x[j] - dot * v1[j]
    return out
  })
  const v2 = topComponent(deflated, opts)

  return centered.map((x) => {
    let a = 0
    let b = 0
    for (let j = 0; j < dim; j++) {
      a += x[j] * v1[j]
      b += x[j] * v2[j]
    }
    return [a, b]
  })
}
