/**
 * Choosing which Drive file to send to the accountant — PURE.
 *
 * This decides which workbook/PDF gets emailed to the accountant and FILED as a
 * real US tax return. A wrong pick files wrong numbers with the IRS.
 *
 * Council 2026-07-17. The original picker matched by name pattern alone (first
 * regex match, Drive-order dependent) across the year subfolder AND the '3. Tax'
 * root, with no year check at all — so a two-year client's 2024 workbook could
 * be attached to a 2025 send. The first fix attempt only asked "does the name
 * contain the year somewhere", which the Council broke immediately:
 *   - "Dynamiq - PnL 2024 (revised 2025-01-30).xlsx" → "proved" 2025. Wrong year.
 *   - "Trend 2025 LLC - PnL 2024 (client-confirmed).xlsx" → the COMPANY NAME
 *     proved 2025. Wrong year — and that name is machine-generated.
 *
 * The rule now — the year must be PROVEN, and proof means unambiguous:
 *  1. The company name is stripped first: it is not evidence about the year.
 *  2. A name proves the year only when the year it mentions is the ONLY year it
 *     mentions. A name carrying two years (a revision date, a fiscal span, a
 *     comparative) proves NOTHING — it is reported for a human, never auto-picked.
 *  3. A name with no year at all is proven by LOCATION when the file sits in the
 *     year subfolder ("3. Tax/2025/P&L final.xlsx" is unambiguous to any human).
 *  4. Anything else is rejected. Reporting a file missing is always safer than
 *     emailing a different year's return.
 *  5. When several files survive, the pick is REPORTED as ambiguous. The caller
 *     must treat that note as a stop, not a footnote.
 *
 * This is a stop-gap over file names. The durable fix is to record the Drive file
 * id at attestation time and fetch BY ID (dev_task fa37121d) — then none of this
 * name-matching runs at all.
 */

export interface DriveCandidate {
  id: string
  name: string
  mimeType?: string
  /** Drive's modifiedTime. Only used to help a human tell two candidates apart. */
  modifiedTime?: string
}

/** How a candidate's tax year was established. */
export type YearProof = "name" | "folder"

export interface ScoredCandidate {
  file: DriveCandidate
  proof: YearProof
}

export interface FilePick {
  /** The chosen file, or null when nothing PROVABLY belongs to the year. */
  file: DriveCandidate | null
  /** Every candidate whose year was proven, best first. */
  candidates: DriveCandidate[]
  /**
   * A genuine "which of these is it?" — MORE THAN ONE file provably belongs to
   * the year. Nobody can tell which numbers should be filed, so the caller MUST
   * treat this as a stop until a human names the file.
   */
  ambiguityNote: string | null
  /**
   * Informational: files whose year cannot be read (they mention the year next
   * to another year). NOT a stop — if a clean file won, having an unreadable
   * one lying around must not block the send. Report it and move on.
   */
  conflictNote: string | null
}

export interface PickOptions {
  /** Ids of files sitting in the year subfolder — location proves the year. */
  yearFolderFileIds?: Set<string>
  /**
   * Stripped before reading years AND before matching the name pattern: the
   * company name is evidence about neither. A client called "PNL Consulting LLC"
   * must not have every spreadsheet it owns read as a P&L.
   */
  companyName?: string
  /** Which files are candidates at all (e.g. P&L vs organizer). Tested on the residue. */
  namePattern: RegExp
  /** Accepts a candidate's type, by mime OR by extension — either alone suffices. */
  typeMatches: (f: DriveCandidate) => boolean
}

/** Every standalone 4-digit year (1900–2199) mentioned in a string. */
export function yearsInName(name: string): number[] {
  const found = name.match(/(?<![0-9])(19[0-9]{2}|20[0-9]{2}|21[0-9]{2})(?![0-9])/g)
  if (!found) return []
  return Array.from(new Set(found.map(Number)))
}

/**
 * Remove EVERY occurrence of the company name so its digits never count as year
 * evidence — "Trend 2025 LLC" must not make a file look like a 2025 return.
 *
 * Council 2026-07-17 round 2: a leading-prefix strip was not enough. Our own
 * organizer is named `Tax_Data_{Company}.pdf` (lib/form-to-drive.ts) — the
 * company sits in the MIDDLE and its spaces become underscores, so a
 * leading `startsWith` could never fire and the company's year "proved" the
 * document's year. Match the name however it was slugged in: any case, with
 * spaces, underscores or hyphens between the words.
 */
export function stripCompanyName(name: string, companyName?: string, opts: { all?: boolean } = {}): string {
  const trimmed = companyName?.trim()
  if (!trimmed) return name
  const words = trimmed.split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  return name.replace(new RegExp(words.join("[\\s_-]+"), opts.all === false ? "i" : "gi"), " ")
}

/**
 * Establish a candidate's tax year, or reject it.
 * Returns the proof, "conflict" (mentions the year AND another year), or null.
 */
export function proveYear(
  file: DriveCandidate,
  taxYear: number,
  opts: { yearFolderFileIds?: Set<string>; companyName?: string } = {},
): YearProof | "conflict" | null {
  const residue = stripCompanyName(file.name, opts.companyName)
  const years = yearsInName(residue)
  const inYearFolder = opts.yearFolderFileIds?.has(file.id) ?? false

  if (years.length === 0) return inYearFolder ? "folder" : null
  if (!years.includes(taxYear)) return null
  return years.length === 1 ? "name" : "conflict"
}

/**
 * Lower is better: client-confirmed first, then the year subfolder, then drafts.
 * Scored on the residue, not the raw name — a company called "Gold Coast LLC" or
 * "Holdings" must not read as "old", and the superseded words are whole words.
 * The draft penalty stays BELOW the client-confirmed weight so a stray "copy" in
 * a confirmed file's name can never push an unattested draft above the archive.
 */
function rank(c: ScoredCandidate, yearFolderFileIds: Set<string>, companyName?: string): number {
  const residue = stripCompanyName(c.file.name, companyName)
  return (
    (/client-confirmed/i.test(residue) ? 0 : 4) +
    (yearFolderFileIds.has(c.file.id) ? 0 : 2) +
    (/\b(draft|old|superseded|copy|v[0-9])\b|\([0-9]+\)/i.test(residue) ? 1 : 0)
  )
}

/**
 * Is this file even a document of the wanted kind? Matched on the residue — a
 * client named "PNL Consulting LLC" would otherwise have every .xlsx it owns
 * read as a P&L, and a client named "Relay Ltd" every PDF read as a statement.
 */
export function matchesCategory(file: DriveCandidate, opts: PickOptions): boolean {
  // Only the FIRST occurrence is stripped here. Reading years needs every
  // occurrence gone, but a company whose name IS the category word ("Profit
  // Loss") would otherwise have its own real P&L erased and reported missing.
  return opts.namePattern.test(stripCompanyName(file.name, opts.companyName, { all: false })) && opts.typeMatches(file)
}

/** Pick the file that provably belongs to `taxYear`. */
export function pickFileForYear(files: DriveCandidate[], taxYear: number, opts: PickOptions): FilePick {
  const yearFolderFileIds = opts.yearFolderFileIds ?? new Set<string>()
  const relevant = files.filter(f => matchesCategory(f, opts))

  const proven: ScoredCandidate[] = []
  const conflicted: DriveCandidate[] = []
  for (const file of relevant) {
    const proof = proveYear(file, taxYear, { yearFolderFileIds, companyName: opts.companyName })
    if (proof === "conflict") conflicted.push(file)
    else if (proof) proven.push({ file, proof })
  }
  proven.sort((a, b) => rank(a, yearFolderFileIds, opts.companyName) - rank(b, yearFolderFileIds, opts.companyName))

  // Informational — never a stop. A stray unreadable file must not make having
  // the correct document WORSE than not having it.
  const conflictNote = conflicted.length > 0
    ? `${conflicted.length} file(s) mention ${taxYear} next to another year, so their year cannot be read from the name and they were NOT used: ${conflicted.map(f => `"${f.name}" (id ${f.id})`).join(", ")}`
    : null

  if (proven.length === 0) return { file: null, candidates: [], ambiguityNote: null, conflictNote }

  const file = proven[0].file
  // A real stop: several files provably belong to the year and only a human
  // knows which one holds the numbers to file. Each candidate is described by
  // more than its name — two files can share a name byte-for-byte (a legacy Tax
  // root copy beside its year-folder replacement), and asking someone to choose
  // between two identical lines is asking them to guess.
  const ambiguityNote = proven.length > 1
    ? `${proven.length} files provably belong to ${taxYear} — using ${describe(proven[0], yearFolderFileIds)}. Also: ${proven.slice(1).map(c => describe(c, yearFolderFileIds)).join("; ")}`
    : null
  return { file, candidates: proven.map(c => c.file), ambiguityNote, conflictNote }
}

/** Describe a candidate so a human can actually tell two of them apart. */
function describe(c: ScoredCandidate, yearFolderFileIds: Set<string>): string {
  const where = yearFolderFileIds.has(c.file.id) ? "in the year folder" : "loose in the Tax root"
  const when = c.file.modifiedTime ? `, last changed ${c.file.modifiedTime.slice(0, 10)}` : ""
  return `"${c.file.name}" (${where}${when}, id ${c.file.id})`
}

/**
 * Whether the accountant package may be emailed — PURE, so the rules that stop a
 * wrong filing are testable without Drive, Gmail or a database.
 *
 * Precedence matters and is deliberate:
 *  1. No P&L on an entity that files one — nothing may bypass this.
 *  2. An unresolved "which of these files is it?" — a human must name the file.
 *     Checked BEFORE the optional-docs gate so `send_incomplete` cannot skip it.
 *  3. A P&L-shaped file whose year we could not read, sitting next to the one we
 *     picked. The unreadable file is the MORE suspicious of the two — it is
 *     typically the corrected copy someone renamed ("PnL 2024 (revised 2025)").
 *     Printing that as a footnote and sending anyway is precisely the theatre
 *     this exists to stop, so it blocks until a human names the file.
 *  4. Optional documents missing — the one case `send_incomplete` is for.
 *  5. Nothing found at all.
 */
export interface SendGateInput {
  /** A P&L-filing entity with no P&L that provably belongs to the year. */
  pnlMissing: boolean
  /** Unresolved "several files provably belong to this year" notes. */
  ambiguous: string[]
  /**
   * Unresolved "a P&L-shaped file's year could not be read" notes. Only the P&L's
   * conflicts belong here — a supporting document's do not stop a filing.
   */
  pnlConflicts: string[]
  /** Optional documents that are missing. */
  missing: string[]
  /** The operator's explicit opt-out for missing OPTIONAL documents. */
  sendIncomplete: boolean
  /**
   * A preview never sends, so it is exempt from the ambiguity stop — showing the
   * package IS how the operator gets the ids to resolve it. The other stops still
   * apply: previewing a package that cannot be sent would only mislead.
   */
  isDryRun: boolean
  /** How many documents were gathered. */
  foundCount: number
}

export type SendGateReason = "no_pnl" | "ambiguous" | "pnl_conflict" | "missing_docs" | "no_documents"
/** `reason` is set exactly when `allow` is false. (Not a discriminated union: this
 *  repo compiles with `strict: false`, where that narrowing doesn't hold.) */
export interface SendGate {
  allow: boolean
  reason?: SendGateReason
}

export function decideSendGate(i: SendGateInput): SendGate {
  if (i.pnlMissing) return { allow: false, reason: "no_pnl" }
  // A preview is allowed to show an ambiguous package — that is how the operator
  // sees the ids they need to resolve it. Only the actual send is stopped.
  if (i.ambiguous.length > 0 && !i.isDryRun) return { allow: false, reason: "ambiguous" }
  if (i.pnlConflicts.length > 0 && !i.isDryRun) return { allow: false, reason: "pnl_conflict" }
  if (i.missing.length > 0 && !i.sendIncomplete) return { allow: false, reason: "missing_docs" }
  if (i.foundCount === 0) return { allow: false, reason: "no_documents" }
  return { allow: true }
}

/**
 * Is a loose Tax-root file a superseded copy of one in the year folder? — PURE.
 *
 * The confirmed workbook used to be archived flat into the Tax root and is now
 * archived into `3.Tax/{year}/`. The upsert only replaces same-named files within
 * ONE folder, so every client who attested before that change keeps an orphaned
 * root twin with a BYTE-IDENTICAL name. Left as a rival candidate it made the
 * "which of these is it?" prompt unanswerable (two identical lines) and, chosen
 * wrongly, filed superseded numbers.
 *
 * The dates are COMPARED, never assumed: other paths still write to the Tax root
 * (a submission with no pinned year), so a root twin CAN be the newer one. When
 * it is, it stays a candidate — which surfaces as an ambiguity and stops the
 * send, instead of silently dropping the corrected file.
 *
 * Drive returns RFC3339 UTC timestamps from the same listing on both sides, so
 * string order is time order. Equal dates mean the year-folder copy is the same
 * artifact, filed where it belongs — drop the root one. If EITHER date is missing
 * we cannot compare, so the twin stays a candidate and the send stops instead:
 * "I don't know which is newer" must never resolve to "drop one of them".
 */
export function isSupersededRootCopy(
  rootFile: DriveCandidate,
  yearFolderModifiedByName: Map<string, string>,
): boolean {
  const yearCopyModified = yearFolderModifiedByName.get(rootFile.name)
  if (yearCopyModified === undefined) return false // no namesake — not a copy at all
  if (!yearCopyModified || !rootFile.modifiedTime) return !yearCopyModified && !rootFile.modifiedTime
  return yearCopyModified >= rootFile.modifiedTime
}

/** True when the file provably belongs to `taxYear` (used to filter supporting docs). */
export function belongsToYear(
  file: DriveCandidate,
  taxYear: number,
  opts: { yearFolderFileIds?: Set<string>; companyName?: string } = {},
): boolean {
  const proof = proveYear(file, taxYear, opts)
  return proof === "name" || proof === "folder"
}
