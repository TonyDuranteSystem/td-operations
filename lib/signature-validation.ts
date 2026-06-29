/**
 * Signature validation — rejects "non-signatures" (a single tap/dot or a few
 * stray pixels) so the e-sign flow can't accept an effectively-blank signature.
 *
 * Why this exists: Numero Uno Social LLC's SS-4 was marked "signed" when the
 * client tapped the pad ONCE. signature_pad's `isEmpty()` returns false for a
 * single dot, so the old guard let it through; the resulting dot is invisible on
 * the PDF, so the filed form looked unsigned. This is a pure, unit-tested check
 * shared by the signing page (to disable Submit) and any server-side guard.
 *
 * Input shape is signature_pad's `toData()` output: an array of stroke groups,
 * each `{ points: [{ x, y }, ...] }`.
 */

export type SignaturePoint = { x: number; y: number }
export type SignatureStroke = { points: SignaturePoint[] }

/** Minimum total points across all strokes (a dot is 1–2). */
export const MIN_SIGNATURE_POINTS = 6
/** Minimum extent (px) of the larger bounding-box dimension (a dot is ~0). */
export const MIN_SIGNATURE_EXTENT = 40

/**
 * True when the drawn strokes look like an actual signature rather than a stray
 * dot/tap. Requires enough points AND a large-enough bounding box.
 */
export function isMeaningfulSignature(strokes: SignatureStroke[] | null | undefined): boolean {
  if (!Array.isArray(strokes) || strokes.length === 0) return false

  let totalPoints = 0
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const stroke of strokes) {
    const points = stroke?.points
    if (!Array.isArray(points)) continue
    for (const p of points) {
      if (typeof p?.x !== "number" || typeof p?.y !== "number") continue
      totalPoints++
      if (p.x < minX) minX = p.x
      if (p.x > maxX) maxX = p.x
      if (p.y < minY) minY = p.y
      if (p.y > maxY) maxY = p.y
    }
  }

  if (totalPoints < MIN_SIGNATURE_POINTS) return false
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return false

  const width = maxX - minX
  const height = maxY - minY
  return Math.max(width, height) >= MIN_SIGNATURE_EXTENT
}
