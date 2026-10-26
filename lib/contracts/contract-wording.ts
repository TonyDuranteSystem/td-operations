/**
 * The wording of a short contract (Service Agreement) — one shape for the eight built-in types (in code,
 * SERVICE_CONTENT) and for the stored wording of NEW services (service_contract_texts, frozen on each
 * offer as offers.contract_texts). Pure and client-safe: the contract page validates what it renders and the
 * server validates what it stores with the SAME function, so a stored text can never reach a client in a
 * shape the page would choke on.
 *
 * No markup is allowed anywhere: every string is rendered as plain text, and the one place that builds HTML
 * by hand (the "after signing" panel) escapes it too — rejecting `<` and `>` here is the belt to those braces.
 */

export interface ContractWording {
  title: string
  shortTitle: string
  /** File-name stem of the signed PDF, e.g. "Apostille_Agreement". */
  pdfPrefix: string
  scope: { intro: string; items: readonly string[]; closing: string }
  procedure: { intro: string; steps: ReadonlyArray<{ title: string; desc: string }> }
  commitments: readonly string[]
  clientDuties: { intro: string; items: ReadonlyArray<{ bold: string; rest: string }> }
  signatureText: string
  successNote: string
  /** "…payable in full before {workPhrase} begins" / "…once {workPhrase} has commenced". */
  workPhrase?: string
  /** "…not liable for {liabilityPhrase} resulting from inaccurate, incomplete, or late information…". */
  liabilityPhrase?: string
}

export const WORDING_LIMITS = {
  title: 160,
  pdfPrefix: 60,
  short: 400,
  paragraph: 2000,
  items: 20,
} as const

/** Which line of the wording each problem belongs to, so an editor can show it next to that line. */
export type FieldErrors = Record<string, string[]>

export type WordingResult = { ok: true; wording: ContractWording } | { ok: false; errors: string[]; fields: FieldErrors }

const NO_MARKUP = /[<>]/

// ── **bold** ─────────────────────────────────────────────────────────────────────────────────────────────
// Staff mark bold words with two stars on each side. It is NOT markup: the page splits the text on the stars
// and wraps those pieces in <strong> as React text, never as HTML. Only some lines can carry it (the others
// are already bold, sit inside a fixed sentence, or go into an HTML string), so the validator says which.

export const BOLD_MARK = '**'

export interface InlineSegment { text: string; bold: boolean }

/** Split a line on its ** marks. A stray (unpaired) mark is kept as ordinary text — rendering never fails. */
export function parseInline(text: string): InlineSegment[] {
  const parts = text.split(BOLD_MARK)
  const markers = parts.length - 1
  if (markers < 2) return [{ text, bold: false }]
  const usable = markers - (markers % 2) // markers that form pairs; one stray mark may be left at the end
  const segs: InlineSegment[] = []
  const push = (t: string, bold: boolean) => {
    if (!t) return
    const last = segs[segs.length - 1]
    if (last && last.bold === bold) last.text += t
    else segs.push({ text: t, bold })
  }
  for (let i = 0; i <= usable; i++) push(parts[i], i % 2 === 1)
  if (markers > usable) push(BOLD_MARK + parts.slice(usable + 1).join(BOLD_MARK), false)
  return segs.length > 0 ? segs : [{ text: '', bold: false }]
}

/** The text with its ** marks removed — what a reader sees, e.g. for plain-text places. */
export function stripInline(text: string): string {
  return parseInline(text).map((s) => s.text).join('')
}

class Collector {
  errors: string[] = []
  fields: FieldErrors = {}
  add(key: string, message: string) {
    this.errors.push(message)
    ;(this.fields[key] ??= []).push(message)
  }
}

interface StrOpts {
  optional?: boolean
  allowEmpty?: boolean
  bold?: boolean
  /** Keep leading spaces: the text after a bold part starts with the space that separates it from the bold words. */
  keepLeading?: boolean
}

function str(v: unknown, path: string, key: string, max: number, c: Collector, opts: StrOpts = {}): string {
  if (v === undefined || v === null) {
    if (!opts.optional) c.add(key, `${path} is missing`)
    return ''
  }
  if (typeof v !== 'string') { c.add(key, `${path} must be text`); return '' }
  const t = opts.keepLeading ? v.replace(/\s+$/, '') : v.trim()
  if (!t.trim() && !opts.allowEmpty && !opts.optional) c.add(key, `${path} cannot be empty`)
  if (t.length > max) c.add(key, `${path} is too long (${t.length} characters; the limit is ${max})`)
  if (NO_MARKUP.test(t)) c.add(key, `${path} cannot contain < or > (plain text only)`)
  if (t.includes(BOLD_MARK)) {
    if (!opts.bold) c.add(key, `${path} cannot use ** (bold is not available on this line)`)
    else if ((t.split(BOLD_MARK).length - 1) % 2 === 1) c.add(key, `${path} has a ** without its partner (put ** on both sides of the words to make them bold)`)
    else if (/\*\*\s*\*\*/.test(t)) c.add(key, `${path} has empty bold marks (** **)`)
  }
  return t
}

function list<T>(v: unknown, path: string, key: string, c: Collector, each: (x: unknown, p: string, k: string) => T): T[] {
  if (!Array.isArray(v)) { c.add(key, `${path} must be a list`); return [] }
  if (v.length === 0) c.add(key, `${path} needs at least one entry`)
  if (v.length > WORDING_LIMITS.items) c.add(key, `${path} has too many entries (the limit is ${WORDING_LIMITS.items})`)
  return v.slice(0, WORDING_LIMITS.items).map((x, i) => each(x, `${path} #${i + 1}`, `${key}.${i}`))
}

const obj = (v: unknown, path: string, key: string, c: Collector): Record<string, unknown> => {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  c.add(key, `${path} is missing`)
  return {}
}

/** Validate untrusted wording (from the database, a draft form, or Claude) and return it in clean form. */
export function validateContractWording(raw: unknown): WordingResult {
  const c = new Collector()
  const r = obj(raw, 'The wording', 'wording', c)
  const scope = obj(r.scope, 'Scope', 'scope', c)
  const procedure = obj(r.procedure, 'Procedure', 'procedure', c)
  const duties = obj(r.clientDuties, 'Client responsibilities', 'clientDuties', c)

  const pdfPrefix = str(r.pdfPrefix, 'File name', 'pdfPrefix', WORDING_LIMITS.pdfPrefix, c)
  if (pdfPrefix && !/^[A-Za-z0-9_]+$/.test(pdfPrefix)) c.add('pdfPrefix', 'File name can only use letters, numbers and underscores')

  const wording: ContractWording = {
    title: str(r.title, 'Title', 'title', WORDING_LIMITS.title, c),
    shortTitle: str(r.shortTitle, 'Short title', 'shortTitle', WORDING_LIMITS.title, c),
    pdfPrefix,
    scope: {
      intro: str(scope.intro, 'Scope introduction', 'scope.intro', WORDING_LIMITS.paragraph, c, { bold: true }),
      items: list(scope.items, 'Scope items', 'scope.items', c, (x, p, k) => str(x, p, k, WORDING_LIMITS.short, c, { bold: true })),
      closing: str(scope.closing, 'Scope closing sentence', 'scope.closing', WORDING_LIMITS.paragraph, c),
    },
    procedure: {
      intro: str(procedure.intro, 'Procedure introduction', 'procedure.intro', WORDING_LIMITS.paragraph, c, { bold: true }),
      steps: list(procedure.steps, 'Procedure steps', 'procedure.steps', c, (x, p, k) => {
        const s = obj(x, p, k, c)
        return {
          title: str(s.title, `${p} title`, `${k}.title`, WORDING_LIMITS.title, c),
          desc: str(s.desc, `${p} description`, `${k}.desc`, WORDING_LIMITS.paragraph, c, { bold: true }),
        }
      }),
    },
    commitments: list(r.commitments, 'Service Provider commitments', 'commitments', c, (x, p, k) => str(x, p, k, WORDING_LIMITS.short, c, { bold: true })),
    clientDuties: {
      intro: str(duties.intro, 'Client responsibilities introduction', 'clientDuties.intro', WORDING_LIMITS.paragraph, c, { bold: true }),
      items: list(duties.items, 'Client responsibilities', 'clientDuties.items', c, (x, p, k) => {
        const s = obj(x, p, k, c)
        const bold = str(s.bold, `${p} (bold part)`, k, WORDING_LIMITS.short, c)
        let rest = str(s.rest, `${p} (rest)`, k, WORDING_LIMITS.short, c, { allowEmpty: true, bold: true, keepLeading: true })
        // the bold heading and the words after it are written together: never let them glue ("documentswithin")
        if (rest && /^[^\s;:,.!?)\]'"\u2019]/.test(rest)) rest = ' ' + rest
        return { bold, rest }
      }),
    },
    signatureText: str(r.signatureText, 'Acceptance sentence', 'signatureText', WORDING_LIMITS.paragraph, c),
    successNote: str(r.successNote, 'Message after signing', 'successNote', WORDING_LIMITS.paragraph, c),
  }
  // Required for stored wording: the page falls back to the TAX-RETURN sentence when they are absent, which would put
  // "the tax return preparation" into someone else's contract.
  const work = str(r.workPhrase, 'Work phrase', 'workPhrase', WORDING_LIMITS.short, c)
  const liab = str(r.liabilityPhrase, 'Liability phrase', 'liabilityPhrase', WORDING_LIMITS.short, c)
  if (work) wording.workPhrase = work
  if (liab) wording.liabilityPhrase = liab

  return c.errors.length > 0 ? { ok: false, errors: c.errors, fields: c.fields } : { ok: true, wording }
}

// ── Editing: one text box per line ──────────────────────────────────────────────────────────────────────
// A client duty is stored as { bold, rest }; in the editor it is ONE line, "**bold part**rest", so it is edited
// like every other line. These two functions are the only place that converts between the shapes.

export interface EditableWording extends Omit<ContractWording, 'clientDuties'> {
  clientDuties: { intro: string; items: string[] }
}

export function dutyToLine(d: { bold: string; rest: string }): string {
  return `${BOLD_MARK}${d.bold}${BOLD_MARK}${d.rest}`
}

/** "**bold**rest" -> { bold, rest }; null when the line does not start with a bold part. */
export function dutyFromLine(line: string): { bold: string; rest: string } | null {
  const m = /^\*\*(.+?)\*\*([\s\S]*)$/.exec(line.trim())
  if (!m || !m[1].trim()) return null
  return { bold: m[1], rest: m[2] }
}

export function toEditable(w: ContractWording): EditableWording {
  return { ...w, clientDuties: { intro: w.clientDuties.intro, items: w.clientDuties.items.map(dutyToLine) } }
}

/** Turn the editor's lines back into wording and validate it. Problems come back keyed by the line they belong to. */
export function editableToWording(e: EditableWording): WordingResult {
  const dutyErrors: Array<[string, string]> = []
  const items = e.clientDuties.items.map((line, i) => {
    const d = dutyFromLine(line)
    if (!d) {
      dutyErrors.push([`clientDuties.items.${i}`, `Client responsibilities #${i + 1} must start with a bold part: put ** on both sides of the heading, like **this**`])
      return { bold: 'x', rest: '' }
    }
    return d
  })
  const res = validateContractWording({ ...e, clientDuties: { intro: e.clientDuties.intro, items } })
  if (dutyErrors.length === 0) return res
  const errors = 'errors' in res ? [...res.errors] : []
  const fields: FieldErrors = 'fields' in res ? { ...res.fields } : {}
  for (const [key, msg] of dutyErrors) { errors.push(msg); fields[key] = [...(fields[key] ?? []), msg] }
  return { ok: false, errors, fields }
}

/** What a frozen snapshot entry on an offer looks like (offers.contract_texts[type]). */
export interface ContractTextSnapshot {
  version: number
  hash: string
  content: unknown
  snapshot_at?: string
}

/** The wording of one type from an offer's frozen snapshot, validated; null when absent or not valid. */
export function wordingFromSnapshot(texts: unknown, type: string): ContractWording | null {
  if (!texts || typeof texts !== 'object' || Array.isArray(texts)) return null
  const entry = (texts as Record<string, unknown>)[type]
  if (!entry || typeof entry !== 'object') return null
  const res = validateContractWording((entry as { content?: unknown }).content)
  return res.ok ? res.wording : null
}
