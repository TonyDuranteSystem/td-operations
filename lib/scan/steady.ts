/**
 * Scan document: "hold steady". The camera screen takes the picture by itself once the page outline has stayed in
 * (almost) the same place for a moment. Pure rules, fed one detection result per camera look.
 */
import { dist, type Quad } from './geometry'

export interface SteadyState { steady: boolean; /** 0..1, for the ring around the shutter */ progress: number }

export interface SteadyTracker {
  push(quad: Quad | null, width: number, height: number): SteadyState
  reset(): void
}

/**
 * `needed` = how many looks in a row (about 7 looks = a bit over a second at the camera's pace);
 * `tolerance` = how far a corner may wander between looks, as a share of the picture's diagonal.
 */
export function createSteadyTracker(opts: { needed?: number; tolerance?: number } = {}): SteadyTracker {
  const needed = opts.needed ?? 7
  const tolerance = opts.tolerance ?? 0.02
  let last: Quad | null = null
  let count = 0
  return {
    push(quad, width, height) {
      if (!quad) { last = null; count = 0; return { steady: false, progress: 0 } }
      const diag = Math.hypot(width, height) || 1
      if (last && Math.max(...quad.map((p, i) => dist(p, last![i]))) / diag <= tolerance) count++
      else count = 1
      last = quad
      return { steady: count >= needed, progress: Math.min(1, count / needed) }
    },
    reset() { last = null; count = 0 },
  }
}
