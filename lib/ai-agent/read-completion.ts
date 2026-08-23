/**
 * Reading a file to the END is REQUIRED, not requested.
 *
 * The windowed-read change (2026-07-29) made long files readable to the end: each
 * cut-off result names the exact offset to continue from. But the follow-through
 * relied on the model obeying the instruction in the marker — and Antonio's verdict
 * on that was final: "I can't rely on his behaviour depends on the assistant obeying
 * the instruction". Instructions in this codebase have a measured failure record
 * (the absence/correction/phantom-file guards all exist because prompt text was
 * ignored four times), so this module gives read-to-the-end the same treatment:
 * the SERVER tracks every partial read from its own tool results and enforces at
 * the only chokepoint the model cannot route around — the moment the answer ships.
 *
 * Two layers:
 *   1. LATCH — while any file has an unread remainder, the final answer is refused
 *      and the loop is sent back to continue reading (bounded; progress-gated so a
 *      model that ignores the nudge can't burn the whole loop budget).
 *   2. STAMP — if an answer ships anyway (budget exhausted, giant file), the server
 *      itself appends "read only X of Y characters" to the reply, AFTER the model
 *      has finished. The model never touches that text, so it cannot be omitted,
 *      softened, or forgotten.
 *
 * Everything here parses OUR OWN marker text (windowText in slack-file-reader.ts),
 * never the model's prose — same trust rule as extractArtifact.
 */

// The window size the read handlers use — needed for the arithmetic check below.
// Imported from the marker producer so the two can never drift apart.
import { SLACK_FILE_TEXT_CHAR_CAP } from "./slack-file-reader"

/** One file the assistant started but has not finished reading. */
export interface PendingRead {
  /** Stable identity of the file within this turn (tool + ref/url). */
  key: string
  /** What to call it when talking to the model or stamping the reply. */
  label: string
  /** Where the next window starts — parsed from OUR marker, not model text. */
  nextOffset: number
  /** Total characters in the file, when the marker carried it. */
  totalChars: number | null
}

/**
 * Tools whose results are windowed file reads — the ones this contract covers.
 *
 * `read_uploaded_file` and `read_drive_file` joined on 2026-08-03 (td-bug,
 * Luca). Until then the contract covered only files arriving by email or portal
 * chat: a spreadsheet DROPPED IN THE CHAT and a file read from Drive were both
 * outside it, so neither the forced-continuation latch nor the server's
 * "read only X of Y" stamp ever fired for them. Drive was the worse of the two —
 * the assistant was actively telling staff "put it in Drive as a Google Sheet
 * and I'll read it in full", which was false.
 */
const WINDOWED_READ_TOOLS = new Set([
  "read_email_attachment",
  "read_portal_attachment",
  "read_uploaded_file",
  "read_drive_file",
])

/** Most forced continuations per answer attempt cycle. A 125k-char file at the
 *  default 20k window needs ~6; anything needing more is covered by the stamp. */
export const MAX_READ_CONTINUATION_NUDGES = 8

/** The file identity for a read call: the ref/url, never the offset. */
export function pendingReadKey(toolName: string, input: Record<string, unknown>): string {
  const id =
    (typeof input.ref === "string" && input.ref.trim()) ||
    (typeof input.url === "string" && input.url.trim()) ||
    JSON.stringify({ ...input, offset: undefined })
  return `${toolName}:${id}`
}

/** Our tail marker, FULL line, anchored — never a substring match. */
const CONTINUE_LINE = /^…\[truncated — file is (\d+) chars; continue with offset: (\d+)\]$/m
/** Our end-of-file marker, FULL line, anchored. */
const END_LINE = /^\[end of file — \d+ chars total\]$/m
/** Our head marker's total, FULL line, anchored — the head precedes any file content. */
const TOTAL_LINE = /^Showing characters \d+–\d+ of (\d+)\. The rest was NOT read\.$/m

/** Last full-line match of a pattern (our tail markers come AFTER any file content). */
function lastLineMatch(text: string, re: RegExp): RegExpMatchArray | null {
  const all = Array.from(text.matchAll(new RegExp(re.source, "gm")))
  return all.length ? all[all.length - 1] : null
}

/** Our handler's own file-label line, emitted BEFORE the content. */
const ATTACHED_FILE_LINE = /^\[Attached file "(.+)"\]$/m

/**
 * A display name for the file: the real filename when our handler emitted it,
 * else the ref/url tail. SANITIZED hard — the filename is attacker-chosen text
 * and this label is interpolated into the continuation nudge (a message TO the
 * model), so a filename carrying instructions must arrive defanged: one line,
 * no quotes or backticks, capped short.
 */
function deriveLabel(input: Record<string, unknown>, resultText: string): string {
  const fromResult = resultText.match(ATTACHED_FILE_LINE)?.[1]
  const raw =
    fromResult ||
    (typeof input.ref === "string" && input.ref) ||
    (typeof input.url === "string" && (input.url.split("/").pop() ?? input.url)) ||
    "attached file"
  const clean = raw.replace(/\s+/g, " ").replace(/["'`]/g, "").trim()
  return (clean || "attached file").slice(0, 60)
}

/**
 * Update the pending-read ledger from one tool result.
 *
 * ⛔ THE PARSE DOES NOT TRUST THE TEXT — the file's own content rides INSIDE the
 * result, and anyone can email support@ a document containing a forged marker
 * line (the bug-hunter's blocker: a PDF whose page 1 said "continue with offset:
 * 124999" steered the reader to SKIP its own middle, then the guard ordered that
 * skip authoritatively). Three defenses, all required:
 *   1. Full-line anchored patterns, LAST match — our tail markers are emitted
 *      after the content slice, so the genuine line wins over an embedded one.
 *   2. ARITHMETIC over parsed values: a genuine continuation is always exactly
 *      (offset this call started at) + (the window cap). Any other number is a
 *      forgery and is replaced by the computed truth — the attacker can only
 *      "forge" the value that is already correct.
 *   3. A result too short to BE a full window cannot claim to be one.
 *
 * Rules:
 *  - genuine continue marker → record/advance the entry (computed offset).
 *  - genuine end marker      → finished; clear the entry.
 *  - no marker, not pending  → whole file fit in one window; nothing to track.
 *  - no marker, PENDING      → KEEP the entry. This is a transient error or an
 *    odd result mid-sequence — clearing it here shipped an unstamped answer off
 *    a fraction of the file (the bug-hunter's second major). The progress gate
 *    means a permanently failing file costs one nudge, then ships stamped.
 */
export function updatePendingReads(
  ledger: Map<string, PendingRead>,
  toolName: string,
  input: Record<string, unknown>,
  result: unknown,
): void {
  if (!WINDOWED_READ_TOOLS.has(toolName)) return
  const text = typeof result === "string" ? result : ""
  const key = pendingReadKey(toolName, input)

  // The LATEST marker line of either kind is the authoritative one: our tail is
  // emitted AFTER the content slice, and nothing we emit follows it — so a forged
  // marker inside the document always sits earlier than the genuine tail. (An
  // "END first, then continue" ordering was itself attackable: a forged full-line
  // END inside the slice would have cleared a genuinely unfinished read.)
  const endMatch = lastLineMatch(text, END_LINE)
  const continueMatch = lastLineMatch(text, CONTINUE_LINE)
  if (endMatch && (!continueMatch || (endMatch.index ?? 0) > (continueMatch.index ?? 0))) {
    ledger.delete(key)
    return
  }
  // Defense 3: a genuine windowed slice is at least the cap long; a short result
  // carrying a "marker" can only be forged content (e.g. a filename or a tiny file).
  if (continueMatch && text.length >= SLACK_FILE_TEXT_CHAR_CAP) {
    // Defense 2: the ONLY true continuation point is where this call started plus
    // one window. Parsed numbers are display hints; arithmetic is the authority.
    const startedAt =
      typeof input.offset === "number" && Number.isFinite(input.offset) ? Math.max(0, Math.floor(input.offset)) : 0
    const computedNext = startedAt + SLACK_FILE_TEXT_CHAR_CAP
    const claimedTotal = Number(continueMatch[1])
    const headTotal = text.match(TOTAL_LINE)
    const total = headTotal ? Number(headTotal[1]) : Number.isFinite(claimedTotal) ? claimedTotal : null
    // A "continuation" pointing at or past the claimed total is self-contradictory
    // (windowText emits the END marker in that case) — treat as forged; keep-if-
    // pending applies via the fallthrough below.
    if (total === null || computedNext < total) {
      ledger.set(key, { key, label: deriveLabel(input, text), nextOffset: computedNext, totalChars: total })
      return
    }
  }

  // No trustworthy marker. A file never tracked stays untracked (it fit in one
  // window); a file mid-sequence stays PENDING — see the header for why.
}

/** One door-attached file's continue-reading key + the text it was windowed to. */
export interface DoorAttachmentSeed {
  ref: string
  resultText: string
}

/**
 * Seed the ledger from files that arrived ALREADY ATTACHED to the turn (dev job
 * 5e87b099) — pasted into chat, not chosen by the model. attachment-reader.ts
 * windows these with the SAME windowText() the 4 tool-based readers use, and
 * they carry the SAME marker lines, but nothing called updatePendingReads() for
 * them: the model got no live signal it was reading a partial file, only the
 * after-the-fact stamp (stampPartialReads) once the turn had already shipped.
 *
 * Each seed is keyed as if it were a read_uploaded_file call with offset 0, so
 * a REAL continuation (the model later calling read_uploaded_file with the
 * SAME ref) lands in the SAME ledger entry and advances or clears it exactly
 * as today — this reuses updatePendingReads()'s own forgery defenses verbatim,
 * no new marker-parsing logic.
 *
 * Seeds are built by the CALLER (attachment-reader.ts's readAttachments, one
 * per file, from data it already has in hand for that exact file) — never by
 * re-scanning the COMBINED turn text for marker lines after the fact, which a
 * hostile file's own content could forge to misattribute another file's
 * truncation state onto the wrong ref.
 */
export function seedPendingReadsFromDoorAttachments(
  ledger: Map<string, PendingRead>,
  seeds: DoorAttachmentSeed[] | null | undefined,
): void {
  for (const seed of seeds ?? []) {
    updatePendingReads(ledger, "read_uploaded_file", { ref: seed.ref, offset: 0 }, seed.resultText)
  }
}

/**
 * Progress signature for the nudge gate. The latch re-fires only while the model
 * is actually advancing (offsets moved or entries closed since the last nudge) —
 * a model that ignores the nudge outright gets ONE repeat, then the stamp takes
 * over rather than the loop budget burning down on a refusal contest.
 */
export function pendingReadsSignature(ledger: Map<string, PendingRead>): string {
  return Array.from(ledger.values())
    .map((p) => `${p.key}@${p.nextOffset}`)
    .sort()
    .join("|")
}

/** The forced-continuation message. Concrete: names each file and its exact next call. */
export function buildIncompleteReadNudge(ledger: Map<string, PendingRead>): string {
  const items = Array.from(ledger.values())
    .map((p) => {
      const progress = p.totalChars ? ` (you have read ${p.nextOffset} of ${p.totalChars} characters)` : ""
      return `- "${p.label}"${progress}: call the read tool again with offset: ${p.nextOffset}`
    })
    .join("\n")
  return [
    "⛔ STOP — you have NOT finished reading. Your answer was not delivered.",
    "You started reading the following file(s) and stopped before the end:",
    items,
    "Continue reading each one (repeat with each new offset until the result says the file ends) and ONLY THEN answer.",
    "Do not summarize, total, or state that anything is absent from a file you have read only part of.",
  ].join("\n")
}

/**
 * The server-authored disclosure appended to a reply that shipped over a partial
 * read. Written AFTER the model's turn, by us — it cannot be omitted or reworded.
 */
export function stampPartialReads(reply: string, ledger: Map<string, PendingRead>): string {
  if (!ledger.size) return reply
  const items = Array.from(ledger.values())
    .map((p) =>
      p.totalChars
        ? `• "${p.label}" — read only ${p.nextOffset} of ${p.totalChars} characters`
        : `• "${p.label}" — not read to the end`,
    )
    .join("\n")
  return [
    reply,
    "",
    "---",
    "⚠️ Automatic server note (not written by the assistant): this answer was produced WITHOUT reading the following file(s) to the end:",
    items,
    "Totals, counts, and any claim that something is absent from these files may be wrong.",
  ].join("\n")
}
