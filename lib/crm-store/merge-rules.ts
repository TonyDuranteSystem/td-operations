/**
 * Which ticked files may be merged into ONE new file (Antonio 2026-10-24: only files of the SAME company or the SAME person).
 * Written as a pure function so the rules are tested without a browser — the Bug Hunter's review found the first version, an
 * inline check, let a draft return or a staff-only file be merged into a normal file that could then be shown to the client.
 *
 * In a CLIENT storage the new file is a normal document the person can show to the client, so a file that carries a
 * protection (staff-only, a draft return, "Needs review", a personal document outside the person's own storage) must NOT be
 * merged — the result would lose that protection. In My files / Business (internal, never shown to a client) those flags do not apply.
 */
export interface MergeCandidate {
  name: string
  state: string
  staffOnly: boolean
  personal: boolean
  needsReview?: string | null
  /** none / draft / filed / amended */
  filingStatus?: string | null
  /** the storage the file lives in; undefined = it could not be worked out */
  ownerKey: string | undefined
}

export interface MergeContext {
  /** My files / Business */
  internal: boolean
  /** the kind of storage on screen: company / person / business / private … */
  ownerKind: string | undefined
}

/** null = the files may be merged; otherwise the plain-English reason to show. */
export function mergeBlockReason(files: MergeCandidate[], ctx: MergeContext): string | null {
  if (files.length < 2) return "Tick at least two files to merge."
  if (files.some((f) => f.ownerKey === undefined)) return "Could not tell which storage one of the files belongs to — open its folder again and retry."
  if (new Set(files.map((f) => f.ownerKey)).size > 1) return "Only files of ONE company or ONE person can be merged together — untick the others."
  const trashed = files.find((f) => f.state !== "live")
  if (trashed) return `"${trashed.name}" is in the trash — restore it first.`
  if (ctx.internal) return null
  for (const f of files) {
    if (f.staffOnly) return `"${f.name}" is staff-only — a merged file could be shown to the client, so it cannot be merged. Untick it.`
    if (f.filingStatus === "draft") return `"${f.name}" is a draft return that is not filed yet — merge it after it is filed. Untick it.`
    if (f.needsReview) return `"${f.name}" is marked "Needs review" — settle that first. Untick it.`
    if (f.personal && ctx.ownerKind !== "person") return `"${f.name}" is a personal document — it can only be merged inside that person's own storage. Untick it.`
  }
  return null
}
