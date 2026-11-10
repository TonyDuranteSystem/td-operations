/**
 * Claude edits a file in Storage by sending only the CHANGE (dev job bd21e833, master plan Part 54, step 2). These are the PURE rules:
 * how the small edit instructions are applied to a text file, how a change is described in plain words, and the wording kept with a
 * proposal. No database, no network. The server half is `claude-edit.ts`.
 *
 * An edit instruction must match EXACTLY ONE place unless it says otherwise: a wrong or ambiguous match changes nothing at all
 * (all or nothing), and the reply says which instruction failed and why, so the next try can fix just that one.
 */

export type TextEdit =
  | { op: "replace"; find: string; with: string; all?: boolean }
  | { op: "insert_after"; anchor: string; text: string }
  | { op: "insert_before"; anchor: string; text: string }
  | { op: "append"; text: string }
  | { op: "prepend"; text: string }

export const EDIT_LIMITS = {
  /** instructions in one call */
  maxEdits: 50,
  /** characters in one `find`, `anchor` or `text` */
  maxFieldChars: 200_000,
  /** the edited text may not grow past this many bytes (the same cap as other tool writes) */
  maxResultBytes: 3 * 1024 * 1024,
} as const

/** The wording kept with a version Claude proposed (the file is shown to the client, so Claude's change waits for a person to accept it). */
export const PROPOSAL_PREFIX = "Proposed by Claude: "
/** The wording kept with a version Claude saved straight away (a file the client cannot see). */
export const CLAUDE_EDIT_PREFIX = "Claude edit: "
/** A save that lost a race: the file changed while Claude was editing, so it waits as a not-applied version. */
export const CONFLICT_PREFIX = "Claude's change, not applied because the file changed meanwhile: "

export const isProposalNote = (note: string | null | undefined): boolean => typeof note === "string" && note.startsWith(PROPOSAL_PREFIX)
export const isClaudeNote = (note: string | null | undefined): boolean =>
  typeof note === "string" && (note.startsWith(PROPOSAL_PREFIX) || note.startsWith(CLAUDE_EDIT_PREFIX) || note.startsWith(CONFLICT_PREFIX))

export type EditApplied = { ok: true; text: string; applied: number } | { ok: false; error: string }

const occurrences = (hay: string, needle: string): number => {
  if (!needle) return 0
  let n = 0
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++
  return n
}

const quote = (s: string): string => `"${s.length > 60 ? `${s.slice(0, 57)}...` : s}"`.replace(/\n/g, "\\n")

function checkShape(e: unknown, i: number): string | null {
  const at = `Instruction ${i + 1}`
  if (!e || typeof e !== "object") return `${at} is not an instruction.`
  const o = e as Record<string, unknown>
  const text = (k: string, allowEmpty = false): boolean => typeof o[k] === "string" && (allowEmpty || (o[k] as string).length > 0) && (o[k] as string).length <= EDIT_LIMITS.maxFieldChars
  switch (o.op) {
    case "replace": return text("find") && text("with", true) ? null : `${at} (replace) needs a non-empty "find" and a "with" (empty = delete), each at most ${EDIT_LIMITS.maxFieldChars} characters.`
    case "insert_after":
    case "insert_before": return text("anchor") && text("text") ? null : `${at} (${String(o.op)}) needs a non-empty "anchor" and a non-empty "text".`
    case "append":
    case "prepend": return text("text") ? null : `${at} (${String(o.op)}) needs a non-empty "text".`
    default: return `${at} has an unknown "op" (use replace, insert_after, insert_before, append or prepend).`
  }
}

/** Apply the instructions in order to `base`. All or nothing. Each later instruction sees the result of the earlier ones. */
export function applyTextEdits(base: string, edits: unknown): EditApplied {
  if (!Array.isArray(edits) || edits.length === 0) return { ok: false, error: "edits must be a non-empty list of instructions." }
  if (edits.length > EDIT_LIMITS.maxEdits) return { ok: false, error: `At most ${EDIT_LIMITS.maxEdits} instructions per call.` }
  for (let i = 0; i < edits.length; i++) { const bad = checkShape(edits[i], i); if (bad) return { ok: false, error: bad } }
  let text = base
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i] as TextEdit
    const at = `Instruction ${i + 1}`
    if (e.op === "append") { text = text + e.text; continue }
    if (e.op === "prepend") { text = e.text + text; continue }
    const needle = e.op === "replace" ? e.find : e.anchor
    const n = occurrences(text, needle)
    if (n === 0) return { ok: false, error: `${at}: ${quote(needle)} was not found in the file, so nothing was changed.` }
    if (n > 1 && !(e.op === "replace" && e.all === true)) return { ok: false, error: `${at}: ${quote(needle)} appears ${n} times, so nothing was changed. Use a longer piece of text that appears once${e.op === "replace" ? ', or set "all": true to change every one' : ""}.` }
    if (e.op === "replace") text = e.all === true ? text.split(needle).join(e.with) : text.replace(needle, () => e.with)
    else {
      const idx = text.indexOf(needle)
      const cut = e.op === "insert_after" ? idx + needle.length : idx
      text = text.slice(0, cut) + e.text + text.slice(cut)
    }
  }
  if (Buffer.byteLength(text, "utf8") > EDIT_LIMITS.maxResultBytes) return { ok: false, error: `The edited file would be bigger than ${EDIT_LIMITS.maxResultBytes / 1048576} MB, so nothing was changed.` }
  return { ok: true, text, applied: edits.length }
}

export interface ChangeSummary { linesAdded: number; linesRemoved: number; sample: string[]; sentence: string }

/** A plain description of what changed between two texts (line by line, the unchanged start and end skipped). Never throws. */
export function describeChange(before: string, after: string): ChangeSummary {
  const a = before === "" ? [] : before.split("\n"), b = after === "" ? [] : after.split("\n")
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const removed = a.slice(head, a.length - tail), added = b.slice(head, b.length - tail)
  const sample = added.map((l) => l.trim()).filter(Boolean).slice(0, 3).map((l) => (l.length > 100 ? `${l.slice(0, 97)}...` : l))
  const plural = (n: number) => `${n} line${n === 1 ? "" : "s"}`
  let sentence: string
  if (added.length === 0 && removed.length === 0) sentence = "no visible change"
  else if (removed.length === 0) sentence = `${plural(added.length)} added`
  else if (added.length === 0) sentence = `${plural(removed.length)} removed`
  else sentence = `${plural(added.length)} added, ${plural(removed.length)} removed`
  return { linesAdded: added.length, linesRemoved: removed.length, sample, sentence }
}

/** The one line kept with the version: who, what, and a few words of the new text. Never longer than 600 characters. */
export function versionNote(prefix: string, what: string, instruction?: string | null, basedOn?: number | null): string {
  const extra = (instruction ?? "").trim()
  const tag = basedOn ? basedOnTag(basedOn) : ""
  const line = `${prefix}${what}${extra ? ` — ${extra}` : ""}`
  const room = 600 - tag.length
  return `${line.length > room ? `${line.slice(0, room - 3)}...` : line}${tag}`
}

/** "[based on version N]" kept with a proposal, so accepting it later can tell it was made from an older copy. */
export const basedOnTag = (n: number): string => ` [based on version ${n}]`
export function basedOnVersion(note: string | null | undefined): number | null {
  const m = typeof note === "string" ? /\[based on version (\d+)\]/.exec(note) : null
  return m ? Number(m[1]) : null
}

/** The text of a file ONLY if it is valid UTF-8; otherwise null (a Windows-1252 CSV read as UTF-8 would be corrupted when saved back). */
export function decodeUtf8Strict(bytes: Buffer): string | null {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes) } catch { return null }
}

/** A whole-file save whose bytes are not what the file name says (a .pdf that is not a PDF, a .docx that is not a zip …). */
export function contentMismatch(name: string, bytes: Buffer): boolean {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : ""
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b)
  switch (ext) {
    case "pdf": return !starts(0x25, 0x50, 0x44, 0x46)
    case "png": return !starts(0x89, 0x50, 0x4e, 0x47)
    case "jpg": case "jpeg": return !starts(0xff, 0xd8)
    case "docx": case "xlsx": case "pptx": case "zip": return !starts(0x50, 0x4b)
    default: return false
  }
}

/** What a whole-file save changes, for a non-text file (no line diff): the sizes. */
export function describeWholeFile(oldSize: number | null, newSize: number): string {
  const mb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)
  return oldSize === null ? `a new copy of the file (${mb(newSize)})` : `a new copy of the file (${mb(oldSize)} before, ${mb(newSize)} now)`
}
