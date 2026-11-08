/**
 * Reads an IRS ITIN assignment notice (CP565 / CP565A) from its scanned text — by LABEL and by cross-checks, never by "the first number /
 * the closest date" (Antonio 2026-11-07, dev job fb49265a). Pure: no database, no network, safe in the browser.
 *
 * WHY this exists next to `lib/ocr-helpers.ts`: that reader takes the first 9XX-XX-XXXX it finds and the "Month D, YYYY" date nearest the
 * word "assigned". On a real CP565A the date of birth (printed twice, once right beside the ITIN) wins whenever the scan misreads the
 * notice date, and with no date at all it silently writes TODAY. This reader keeps a date of birth OUT of the issue date, tolerates scan
 * noise, says how sure it is for every field and shows the words each value came from, so a person can check it against the scan.
 * It never returns today's date and never guesses a value it has no evidence for. The four older callers are NOT changed by this file.
 *
 * Two layouts are known (both read from real letters):
 *  - "CP565"  : a header box with a labelled "Notice date" and "Date of birth", then "We assigned you … (ITIN) 9XX-XX-XXXX".
 *  - "CP565A" : the notice date is a loose line under the address block (no label), "Date of Birth:" sits at the top right.
 */

export type FieldStatus = "ok" | "unsure" | "missing"

export interface ReadField {
  /** the value (ITIN as 9XX-XX-XXXX, dates as yyyy-mm-dd); null when there is nothing to propose */
  value: string | null
  /** ok = labelled / repeated / clean; unsure = a person must look at the scan before it is used; missing = nothing found */
  status: FieldStatus
  /** a few words of the text the value was read from */
  evidence: string | null
  /** plain words for staff when status is not "ok" */
  note: string | null
  /** other values that were found for the same field (never used) */
  others: string[]
}

export interface ItinLetterReading {
  /** the text looks like an IRS ITIN assignment notice at all */
  isItinNotice: boolean
  noticeKind: "CP565" | "CP565A" | null
  itin: ReadField
  /** the notice date — what the CRM keeps as the ITIN issue date */
  noticeDate: ReadField
  /** read only to keep it out of the issue date and to show it; it is never saved by this feature */
  dateOfBirth: ReadField
  /** the name printed in the address block, for display (the owner is decided by naming the members, not by this) */
  nameOnLetter: string | null
  problems: string[]
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
const MONTH_RE = "(January|February|March|April|May|June|July|August|September|October|November|December)"
/** the first notices were issued with the program in 1996; an earlier date is a date of birth or a misread */
const EARLIEST_NOTICE = "1996-01-01"

const field = (over: Partial<ReadField> = {}): ReadField => ({ value: null, status: "missing", evidence: null, note: null, others: [], ...over })

/** non-breaking spaces and every dash look-alike become plain ones; the text keeps its line breaks */
export function normalizeLetterText(text: string): string {
  return (text || "")
    .replace(/[   ]/g, " ")
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/\r/g, "")
    // a run of blanks is ONE blank and a run of line breaks (with blanks between) is ONE line break: shorter text for the patterns below
    // and no way to make them slow with a long run of whitespace
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n[ \n]*/g, "\n")
}

/** the words around a position, on one line — what the card shows as "where this came from" */
function snippet(text: string, index: number, length: number): string {
  const from = Math.max(0, index - 36)
  return text.slice(from, Math.min(text.length, index + length + 14)).replace(/\s+/g, " ").trim()
}

// ───────────────────────────── ITIN number ─────────────────────────────

/** The IRS only issues an ITIN whose 4th–5th digits are 50–65, 70–88, 90–92 or 94–99. */
export function isValidItinMiddle(middle: string): boolean {
  const n = Number(middle)
  return /^\d{2}$/.test(middle) && ((n >= 50 && n <= 65) || (n >= 70 && n <= 88) || (n >= 90 && n <= 92) || (n >= 94 && n <= 99))
}

/** True for a well-formed ITIN, with or without dashes/spaces. */
export function isValidItin(value: string | null | undefined): boolean {
  const m = /^(9\d{2})[- ]?(\d{2})[- ]?(\d{4})$/.exec((value ?? "").trim())
  return !!m && isValidItinMiddle(m[2])
}

/** 9XX-XX-XXXX from any well-formed spelling; null when it is not an ITIN. */
export function formatItin(value: string | null | undefined): string | null {
  const m = /^(9\d{2})[- ]?(\d{2})[- ]?(\d{4})$/.exec((value ?? "").trim())
  return m && isValidItinMiddle(m[2]) ? `${m[1]}-${m[2]}-${m[3]}` : null
}

function readItin(text: string): ReadField {
  const re = /\b(9\d{2})[- ]?(\d{2})[- ]?(\d{4})\b/g
  const found = new Map<string, { count: number; index: number; length: number }>()
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (!isValidItinMiddle(m[2])) continue
    // "CA 95650-1234": a ZIP+4 right after a state abbreviation is an address, not an ITIN
    if (/(^|[^A-Za-z])[A-Z]{2},?\s$/.test(text.slice(Math.max(0, m.index - 5), m.index))) continue
    const key = `${m[1]}-${m[2]}-${m[3]}`
    const prev = found.get(key)
    if (prev) prev.count++
    else found.set(key, { count: 1, index: m.index, length: m[0].length })
  }
  const all = Array.from(found.entries()).sort((a, b) => b[1].count - a[1].count || a[1].index - b[1].index)
  if (all.length === 0) {
    return field({ note: "No ITIN number (9XX-XX-XXXX with a valid middle) was found in the text — type it from the scan." })
  }
  const [value, top] = all[0]
  const others = all.slice(1).map(([v]) => v)
  const clear = all.length === 1 || top.count > all[1][1].count
  if (!clear) {
    return field({ value, status: "unsure", evidence: snippet(text, top.index, top.length), others, note: "Two different ITIN-like numbers appear the same number of times — check which one is the person's ITIN on the scan." })
  }
  // an ITIN the notice prints more than once (header sentence + table) is read twice: that is the strong case. A number that survived
  // the scan only ONCE could be a misread digit, whatever else is on the page — a person looks.
  if (top.count >= 2) {
    return field({ value, status: "ok", evidence: snippet(text, top.index, top.length), others })
  }
  return field({ value, status: "unsure", evidence: snippet(text, top.index, top.length), others, note: "The number appears only once — check it against the scan." })
}

// ──────────────────────────────── dates ────────────────────────────────

interface DateHit {
  iso: string
  index: number
  length: number
  /** "Month D, YYYY" with a comma and a space — anything else means the scan garbled the punctuation */
  canonical: boolean
  label: "notice" | "birth" | null
}

function isRealDate(y: number, m: number, d: number): boolean {
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

function pad(n: number): string { return n < 10 ? `0${n}` : String(n) }

/** The label that sits right before a date, when there is one. The window crosses line breaks (a header box prints label, newline, value). */
function labelBefore(text: string, index: number): "notice" | "birth" | null {
  const before = text.slice(Math.max(0, index - 34), index)
  const notice = before.search(/notice\s*date\s*:?\s*$/i)
  const birth = before.search(/(date\s*of\s*birth|birth\s*date|d\.?o\.?b\.?)\s*:?\s*"?\s*$/i)
  if (notice >= 0 && birth < 0) return "notice"
  if (birth >= 0 && notice < 0) return "birth"
  return null
}

function findDates(text: string): DateHit[] {
  const re = new RegExp(`\\b${MONTH_RE}\\s*(\\d{1,2})\\s*([,.]?)\\s*(\\d{4})\\b`, "gi")
  const hits: DateHit[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const month = MONTHS.indexOf(m[1].toLowerCase()) + 1
    const day = Number(m[2])
    const year = Number(m[4])
    if (!isRealDate(year, month, day)) continue
    hits.push({
      iso: `${year}-${pad(month)}-${pad(day)}`,
      index: m.index,
      length: m[0].length,
      canonical: /^[A-Za-z]+ \d{1,2}, \d{4}$/.test(m[0]),
      label: labelBefore(text, m.index),
    })
  }
  return hits
}

const distinct = (xs: string[]): string[] => Array.from(new Set(xs))

/** Today as yyyy-mm-dd in UTC; passed in by tests. */
function todayIso(now: Date): string { return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}` }

/**
 * The common case: the letter holds exactly TWO distinct dates — the date of birth and the notice date. Chronology decides which is which
 * (a notice cannot predate the birth), so the layout and the order the scan was read in do not matter. Labels only add confidence, and a
 * label that points the other way (a "date of birth" label sitting on the LATER date — what happens when a header box is read as "all the
 * labels, then all the values") means the labels are not tied to these values: the chronology still decides, but a person must look.
 */
function readTwoDates(text: string, hits: DateHit[], all: string[], now: Date): { notice: ReadField; birth: ReadField } {
  const [early, late] = all
  const ev = (h: DateHit) => snippet(text, h.index, h.length)
  const hLate = hits.filter((h) => h.iso === late)
  const hEarly = hits.filter((h) => h.iso === early)
  const showLate = hLate.find((h) => h.canonical) ?? hLate[0]
  const showEarly = hEarly.find((h) => h.canonical) ?? hEarly[0]
  const plausible = late >= EARLIEST_NOTICE && late <= todayIso(now)
  const labelsAgree = hEarly.some((h) => h.label === "birth") || hLate.some((h) => h.label === "notice")
    || (/notice\s*date/i.test(text) && /date\s*of\s*birth/i.test(text))
  const labelsContradict = hLate.some((h) => h.label === "birth") || hEarly.some((h) => h.label === "notice")
  const clean = hLate.some((h) => h.canonical) || hLate.length >= 2
  // two dates only days or weeks apart are far more likely to be the date of birth read twice (one copy misread) than a birth and a notice:
  // an ITIN needs a filed return and weeks of processing
  const gapDays = (Date.parse(`${late}T00:00:00Z`) - Date.parse(`${early}T00:00:00Z`)) / 86400000
  if (gapDays < 180) {
    return {
      notice: field({ value: late, status: "unsure", evidence: ev(showLate), others: [early], note: "The two dates on the letter are very close together — one may be the date of birth read a second time with a wrong digit. Check the notice date against the scan." }),
      birth: field({ value: early, status: "unsure", evidence: ev(showEarly), note: "Taken as the date of birth because it is the earlier of the two dates." }),
    }
  }
  if (!plausible) {
    return {
      notice: field({ value: late, status: "unsure", evidence: ev(showLate), note: "This date looks wrong for a notice (before 1996 or in the future) — check it against the scan." }),
      birth: field({ value: early, status: "unsure", evidence: ev(showEarly), note: "Taken as the date of birth because it is the earlier of the two dates." }),
    }
  }
  if (labelsAgree && clean && !labelsContradict) {
    return { notice: field({ value: late, status: "ok", evidence: ev(showLate) }), birth: field({ value: early, status: "ok", evidence: ev(showEarly) }) }
  }
  const why = labelsContradict
    ? "The labels do not line up with the dates here, so the later of the two dates was taken as the notice date — check it against the scan."
    : !clean
      ? "The text around this date is garbled (a wrong comma or period can hide a wrong digit) — check the date against the scan."
      : "No \"Notice date\" label could be tied to this date — it was taken as the later of the two dates; check it against the scan."
  return {
    notice: field({ value: late, status: "unsure", evidence: ev(showLate), note: why }),
    birth: field({ value: early, status: "unsure", evidence: ev(showEarly), note: "Taken as the date of birth because it is the earlier of the two dates." }),
  }
}

function readDates(text: string, now: Date): { notice: ReadField; birth: ReadField } {
  const hits = findDates(text)
  const all = distinct(hits.map((h) => h.iso)).sort()
  if (all.length === 2) return readTwoDates(text, hits, all, now)

  // Otherwise (one date, or three and more): the labels are all there is — and a date is only ever taken from a label that sits right before it.
  const today = todayIso(now)
  const ev = (h: DateHit) => snippet(text, h.index, h.length)
  const plausibleNotice = (iso: string) => iso >= EARLIEST_NOTICE && iso <= today

  const birthLabelled = hits.filter((h) => h.label === "birth")
  let birth = field()
  const birthValues = distinct(birthLabelled.map((h) => h.iso))
  if (birthValues.length === 1) birth = field({ value: birthValues[0], status: "ok", evidence: ev(birthLabelled[0]) })
  else if (birthValues.length > 1) birth = field({ value: birthValues[0], status: "unsure", evidence: ev(birthLabelled[0]), others: birthValues.slice(1), note: "More than one date of birth was read — check the scan." })

  const noticeLabelled = hits.filter((h) => h.label === "notice")
  const noticeValues = distinct(noticeLabelled.map((h) => h.iso))
  let notice = field()
  if (noticeValues.length === 1) {
    const value = noticeValues[0]
    // one reading of one label is not enough (a label can sit on the wrong value in a "labels first, values later" box): two agreeing readings, one of them clean
    const clean = noticeLabelled.length >= 2 && noticeLabelled.some((h) => h.canonical)
    if (!plausibleNotice(value)) {
      notice = field({ value, status: "unsure", evidence: ev(noticeLabelled[0]), note: "This date looks wrong for a notice (before 1996 or in the future) — check it against the scan." })
    } else if (clean && (birthValues.length === 0 || birthValues[0] < value)) {
      notice = field({ value, status: "ok", evidence: ev(noticeLabelled[0]) })
    } else {
      notice = field({ value, status: "unsure", evidence: ev(noticeLabelled[0]), note: noticeLabelled.length < 2 ? "This date was read only once — check it against the scan." : "The text around this date is garbled (a wrong comma or period can hide a wrong digit) — check the date against the scan." })
    }
  } else if (noticeValues.length > 1) {
    notice = field({ value: noticeValues[0], status: "unsure", evidence: ev(noticeLabelled[0]), others: noticeValues.slice(1), note: "The notice date is read differently in different places — check it against the scan." })
  } else if (all.length === 0) {
    notice = field({ note: "No date was found in the text — type the notice date from the scan." })
  } else {
    // no "Notice date" label tied to a date: never choose among several, and never offer a date that is only a date of birth
    const birthSet = new Set(birthValues)
    const restValues = all.filter((d) => !birthSet.has(d))
    notice = field({ status: "unsure", others: restValues, note: restValues.length === 0 ? "The only date found is the date of birth — type the notice date from the scan." : "Several dates were found and none could be tied to \"Notice date\" — type the notice date from the scan." })
  }

  // a notice date that equals the date of birth is the date of birth: never offered
  if (notice.value && birth.value && notice.value === birth.value) {
    notice = field({ status: "unsure", others: [notice.value], note: "The only date found is the date of birth — type the notice date from the scan." })
  }
  // a notice always prints TWO dates (birth and notice): when only one was read, whatever label it sits under, it may be the date of birth
  if (all.length === 1 && notice.status === "ok") {
    notice = { ...notice, status: "unsure", note: "Only one date could be read, and a notice prints two (birth and notice) — check that this is the notice date, against the scan." }
  }
  return { notice, birth }
}

/** A staff-typed or staff-confirmed issue date: a real date, not before 1996, not in the future, and not the person's date of birth. */
export function checkIssueDate(iso: string | null | undefined, opts: { dateOfBirth?: string | null; now?: Date } = {}): { ok: boolean; reason: string | null } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((iso ?? "").trim())
  if (!m || !isRealDate(Number(m[1]), Number(m[2]), Number(m[3]))) return { ok: false, reason: "The date is not a real date (use year-month-day)." }
  const value = `${m[1]}-${m[2]}-${m[3]}`
  const today = todayIso(opts.now ?? new Date())
  if (value < EARLIEST_NOTICE) return { ok: false, reason: "The date is before 1996 — an ITIN notice cannot be that old." }
  if (value > today) return { ok: false, reason: "The date is in the future." }
  if (opts.dateOfBirth && value === opts.dateOfBirth) return { ok: false, reason: "That is the date of birth, not the notice date." }
  if (opts.dateOfBirth && value < opts.dateOfBirth) return { ok: false, reason: "The date is before the date of birth — a notice cannot predate the birth." }
  return { ok: true, reason: null }
}

// ───────────────────────── the name, the kind, the whole ─────────────────────────

const STREET_WORD = /\b(st|ste|suite|street|ave|avenue|rd|road|blvd|dr|drive|ln|lane|way|ct|court|pl|place|apt|unit|hwy|pkwy|po box)\b|#/i

/** The person's name printed in the address block: a 2–4 word line of capitals right before the street line. Display only. */
function readNameOnLetter(text: string): string | null {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean)
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]
    const next = lines[i + 1]
    if (!/^\d+\s+\S/.test(next) || !STREET_WORD.test(next)) continue
    // 2–4 words of letters ("PETER PAPiK" — a scan may turn one capital into a lower-case letter), starting with a capital
    if (/^[A-Za-z][A-Za-z.'’-]+( [A-Za-z][A-Za-z.'’-]+){1,3}$/.test(line) && /[A-Z]/.test(line.charAt(0)) && !/^(department|internal|austin)\b/i.test(line)) {
      return line.replace(/\s+/g, " ")
    }
  }
  return null
}

const strip = (s: string): string => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()

/** The words of a name (case and accents ignored, one-letter words dropped). */
export function nameWords(fullName: string | null | undefined): string[] {
  return strip(fullName ?? "").split(/[^a-z0-9]+/).filter((w) => w.length >= 2)
}

/** Could these two spellings be the SAME person? True when they share at least one whole word ("Pete Papik" / "Peter Papik"); false for two different people. */
export function namesShareAWord(a: string | null | undefined, b: string | null | undefined): boolean {
  const wb = nameWords(b)
  return nameWords(a).some((w) => wb.indexOf(w) !== -1)
}

/**
 * Does the letter name this person? First AND last word of the person's name must both appear as whole words (a middle name may be
 * left out of the letter). Case, accents and "Last, First" order do not matter. null = the name has no usable first and last word.
 */
export function personNamedInText(text: string, fullName: string | null | undefined): boolean | null {
  const words = nameWords(fullName)
  if (words.length < 2) return null
  // the IRS's own return address ("Austin, TX 78714-9342") is on every notice: its city must never count as somebody's name
  const hay = strip(text).replace(/\baustin,?\s+tx\b\s*\d{5}(-\d{4})?/g, " ")
  const has = (w: string) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(hay)
  return has(words[0]) && has(words[words.length - 1])
}

/** Read one letter's text. `now` is only used to refuse a notice date in the future (tests pass it). */
export function readItinLetter(rawText: string, now: Date = new Date()): ItinLetterReading {
  const text = normalizeLetterText(rawText)
  // "CP565A": the A must END the word ("CP565 and …" and "CP565 Austin" are plain CP565)
  const kindMatch = /CP\s*-?\s*565(A\b)?/i.exec(text)
  // without "CP565" (a scan can garble it) the notice's own sentences must be there: an expiry reminder that merely says "ITIN assigned in 2019" is not an assignment notice
  const itinPhrase = /individual\s+taxpayer\s+identification\s+number/i.test(text)
  const assignedPhrase = /(we\s+assigned\s+you|you.?ve\s+been\s+assigned|confirms\s+your\s+assigned)/i.test(text)
  const isItinNotice = !!kindMatch || (itinPhrase && assignedPhrase)
  const problems: string[] = []
  if (!isItinNotice) {
    problems.push("This does not look like an IRS ITIN notice (CP565) — nothing was read from it.")
    return { isItinNotice: false, noticeKind: null, itin: field(), noticeDate: field(), dateOfBirth: field(), nameOnLetter: null, problems }
  }
  const itin = readItin(text)
  const { notice, birth } = readDates(text, now)
  if (itin.status !== "ok" && itin.note) problems.push(itin.note)
  if (notice.status !== "ok" && notice.note) problems.push(notice.note)
  return {
    isItinNotice: true,
    noticeKind: kindMatch ? (kindMatch[1] ? "CP565A" : "CP565") : null,
    itin,
    noticeDate: notice,
    dateOfBirth: birth,
    nameOnLetter: readNameOnLetter(text),
    problems,
  }
}
