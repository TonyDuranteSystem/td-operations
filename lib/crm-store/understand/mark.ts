/**
 * File Understanding — what the storage screen shows per file (job 685467b5, 2026-09-30 "AI inside the storage").
 * PURE. The badge is DERIVED at read time from the paid facts (what the AI said) and the file's CURRENT state — it is never a
 * stored verdict, so a retype / rename / move / removed twin can never leave a stale "looks right" on screen.
 *   none        not checked yet (no mark)
 *   looks_right the AI agrees with the file's type and nothing conflicts — this is NOT "proven correct"; staff confirmations teach it
 *   look        worth a look: the AI disagrees, could not tell, could not read, or a look-alike differs
 *   conflict    a real conflict: the text names another client, or tried to instruct the AI
 *   skipped     a personal / ID-like file left out of a bulk check — checked only when staff ask for that one file
 * "No example yet" is a system-learning state and is NEVER a mark on a row (Antonio saw 6 of 6 red on the first real run).
 */
export type AiMark = "none" | "looks_right" | "look" | "conflict" | "skipped"

export interface MarkInput {
  analysis: {
    status: string; ai_type: string | null; ai_injection: boolean | null; owner_named: boolean | null
    duplicate_kind: string | null; word_count: number | null; problem: string | null; updated_at: string | null
  } | null
  /** the file's type slug NOW (from the file itself) */
  fileTypeSlug: string | null
  /** the twin still exists as a live file */
  twinLive: boolean
  typeName: (slug: string) => string
}
export interface MarkResult { mark: AiMark; headline: string; reasons: string[]; checkedAt: string | null }

const DUP_DIFFERS = new Set(["different_words", "minor_marks", "not_compared"])

export function deriveMark(i: MarkInput): MarkResult {
  const a = i.analysis
  if (!a) return { mark: "none", headline: "Not checked", reasons: [], checkedAt: null }
  const checkedAt = a.updated_at
  if (a.status === "unreadable") return { mark: "look", headline: "Could not be read", reasons: [a.problem || "The file could not be read."], checkedAt }
  if (a.status !== "judged") return { mark: "look", headline: "The AI could not be reached", reasons: ["The file was read, but the AI could not judge it. Try again."], checkedAt }

  const reasons: string[] = []
  let mark: AiMark = "looks_right"
  const raise = (m: AiMark) => { if (m === "conflict" || (m === "look" && mark !== "conflict")) mark = m }

  if (a.ai_injection === true) { reasons.push("The file's text tried to give the AI instructions — treat it with care."); raise("conflict") }
  if (a.owner_named === false) { reasons.push("It does not seem to name this client — it may belong to another client."); raise("conflict") }
  if (!a.ai_type) { reasons.push("The AI could not tell what this is."); raise("look") }
  else if (!i.fileTypeSlug) { reasons.push(`Not typed yet — it looks like ${i.typeName(a.ai_type)}.`); raise("look") }
  else if (a.ai_type !== i.fileTypeSlug) { reasons.push(`Filed as ${i.typeName(i.fileTypeSlug)}, but it looks like ${i.typeName(a.ai_type)}.`); raise("look") }
  if (i.twinLive && a.duplicate_kind && DUP_DIFFERS.has(a.duplicate_kind)) { reasons.push("Another file has almost the same words, but they are not identical."); raise("look") }
  if ((a.word_count ?? 0) === 0 && mark === "looks_right") { reasons.push("No words were found — it was judged from its picture."); raise("look") }

  return { mark, headline: mark === "looks_right" ? "Looks right" : mark === "conflict" ? "Doesn't match" : "Look at this", reasons, checkedAt }
}

/**
 * A file that could be a passport / ID or sit in a person's own papers: its type says so, or it lives in a person's storage or
 * a Contacts folder, or it is an untyped picture. A BULK check leaves these out; a click on that one file still works.
 */
export function isPersonalLike(f: { documentType: string | null; personalSlugs: Set<string>; ownerKind: string | null; folderKind: string | null; mime: string | null; name: string }): boolean {
  if (f.documentType && f.personalSlugs.has(f.documentType)) return true
  if (f.ownerKind === "person" || f.folderKind === "contacts") return true
  if (!f.documentType && (/^image\//i.test(f.mime ?? "") || /\.(heic|heif|jpe?g|png|webp|tiff?)$/i.test(f.name))) return true
  return false
}

/** About 0.4 cent per file on the default model (measured 2026-09-30: 6 files = $0.023). */
export const EST_USD_PER_FILE = 0.004
export function estimateUsd(files: number): number { return Math.ceil(files * EST_USD_PER_FILE * 100) / 100 }
