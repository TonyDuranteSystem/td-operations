/**
 * Page-number list for the inbox pager: 1 … 4 5 [6] 7 8 … 107.
 *
 * Always shows the first and last page plus a window around the current one, so
 * a 107-page mailbox doesn't render 107 buttons. `null` is an ellipsis gap.
 * Pure so it can be unit-tested without React.
 */
export function buildPageNumbers(
  page: number,
  totalPages: number,
  windowSize = 2,
): Array<number | null> {
  if (!Number.isFinite(totalPages) || totalPages <= 1) return []
  const current = Math.min(Math.max(1, Math.floor(page) || 1), totalPages)
  // Short lists: show every page — "1 2 3 … 5" is noise, not help.
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1)
  }
  const wanted = new Set<number>([1, totalPages])
  for (let n = current - windowSize; n <= current + windowSize; n++) {
    if (n >= 1 && n <= totalPages) wanted.add(n)
  }
  const out: Array<number | null> = []
  let prev = 0
  for (const n of Array.from(wanted).sort((a, b) => a - b)) {
    if (prev && n - prev > 1) out.push(null)
    out.push(n)
    prev = n
  }
  return out
}
