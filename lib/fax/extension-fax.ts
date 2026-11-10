/**
 * Tax Return "1st Installment Paid" step — file the EXTENSION from the workspace: generate the Form 7004, fax it to the IRS, and when the fax
 * is delivered the system merges the form and the fax receipt into ONE document, saves it in the company's Tax folder, moves the job to
 * "Extension Filed" and tells the client in the portal chat (plan item 7, dev job 6f555c9f, 2026-11-09).
 *
 * The pure rules, no database and no network, so every decision the box and the delivery check make is tested on its own:
 *  - who gets the box (single-member LLCs: their Form 7004 is faxed; the other companies keep the plain upload box for now),
 *  - what the box shows (generate / ready to send / waiting / delivered / failed / never confirmed),
 *  - the names of the files and the text of the client's message.
 *
 * The send itself is the shared fax engine (POST /api/tools/fax/send) with the purpose tag below; the delivery check lives in
 * lib/fax/extension-fax-delivery.ts. The return fax (lib/fax/return-fax.ts, the "Signed" step) is a DIFFERENT fax of the same job: the purpose
 * tag keeps the two apart everywhere a job's faxes are read (the send guard, both boxes' state, both delivery checks).
 */

import { decideReturnFaxOutcome, usesReturnFaxBox, type FaxLogRow, type MarkerRow } from '@/lib/fax/return-fax'
import { companyOfficialRow, isTdLargoAddressRow } from '@/lib/addresses'

/** Stamped on the history row of every fax sent from this box (`details.purpose`). Nothing else may carry it. */
export const EXTENSION_FAX_PURPOSE = 'tax_extension_7004'

/**
 * The number the IRS names for a foreign-owned U.S. disregarded entity's Form 7004 (Instructions for Form 5472, "Extension of time to file",
 * irs.gov/instructions/i5472, read 2026-11-09). It is only the FIRST suggestion: the IRS can change it, so the box shows the number as an editable
 * field and remembers the last number a 7004 fax was DELIVERED to (see lastDeliveredNumber).
 */
export const DEFAULT_EXTENSION_FAX_NUMBER = '8558877737'

/** The steps this box works between. */
export const EXTENSION_STAGES = {
  /** the first installment is paid: the extension is ready to be filed from the workspace */
  waiting: '1st Installment Paid',
  /** the extension is filed (the fax was delivered) */
  filed: 'Extension Filed',
} as const

/** The activity-log markers the delivery check writes (one per fax job id, so a re-run never repeats an alert or a filing). */
export const EXTENSION_FAX_MARKERS = {
  confirmed: 'extension_fax_confirmed',
  failed: 'extension_fax_failed',
  stale: 'extension_fax_stale',
  /** Faxage says the fax was delivered, but to a number nobody has confirmed is the IRS: the job is held until a person says so */
  recipientUnverified: 'extension_fax_recipient_unverified',
  /** a person confirmed that the number this fax went to is the IRS (written by the box's "Yes, that was the IRS") */
  recipientConfirmed: 'extension_fax_recipient_ok',
  /** one row per attempt to file a delivered fax: only the earliest recent one proceeds, so two checks at the same moment never file twice */
  filingClaim: 'extension_fax_filing_claim',
} as const

/** Delivered, but Faxage still gives no receipt page after this long: the extension is filed anyway (the fax WAS delivered), without the receipt. */
export const EXTENSION_RECEIPT_GRACE_MINUTES = 360

/** A filing claim older than this is a crashed attempt and no longer blocks a retry (a filing takes seconds). */
export const FILING_CLAIM_MINUTES = 3

/** A phone number as 10 digits (a leading 1 dropped); anything else comes back as the digits it has. Pure. */
export function faxDigits(raw: string | null | undefined): string {
  const d = (raw ?? '').replace(/\D/g, '')
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d
}

/** True when the number is the IRS Form 7004 number this system knows (the other trusted numbers are the ones a person has confirmed). Pure. */
export function isKnownIrsExtensionNumber(raw: string | null | undefined): boolean {
  return faxDigits(raw) === DEFAULT_EXTENSION_FAX_NUMBER
}

/**
 * The ORIGINAL due date of the return of `taxYear` (calendar-year filer): April 15 of the next year, moved to the Monday when that is a weekend.
 * Holidays are not modelled (a day or two off only changes when the late warning shows; it never blocks). Pure. ISO date.
 */
export function originalDueDateIso(taxYear: number): string {
  const d = new Date(Date.UTC(taxYear + 1, 3, 15))
  const dow = d.getUTCDay()
  if (dow === 6) d.setUTCDate(d.getUTCDate() + 2)
  else if (dow === 0) d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/** Today's date in New York as YYYY-MM-DD (the IRS counts days there; the server clock is UTC, which is already "tomorrow" after 8 pm). */
export function todayNewYork(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/** True when `todayIso` (YYYY-MM-DD, New York date) is after the original due date of `taxYear`: a Form 7004 filed now is late. Pure. */
export function isPastOriginalDueDate(taxYear: number | null | undefined, todayIso: string): boolean {
  if (!taxYear || !Number.isFinite(taxYear)) return false
  return todayIso > originalDueDateIso(taxYear)
}

/** The name prefix that tells the working copy (the 7004 exactly as faxed) from the merged document apart. */
export const WORKING_COPY_PREFIX = 'Form 7004 (as faxed)'

/** The box is for single-member LLCs only (like the return fax box); the other companies keep the plain upload box until it is decided. */
export function usesExtensionFaxBox(entityType: string | null | undefined): boolean {
  return usesReturnFaxBox(entityType)
}

/** True when an activity-log row is a fax sent from THIS box. */
export function isExtensionFaxDetails(details: { purpose?: unknown } | null | undefined): boolean {
  return !!details && details.purpose === EXTENSION_FAX_PURPOSE
}

/** What a Faxage status means for an extension fax: the same rule as the return fax (delivered / failed / waiting / waiting too long). */
export const decideExtensionFaxOutcome = decideReturnFaxOutcome

/**
 * The number to pre-fill: the last number an extension fax was DELIVERED to (a number that has been tried and worked), else the IRS number
 * above. `confirmed` is the markers of the confirmed extension faxes, newest first. Digits only. Pure.
 */
export function lastDeliveredNumber(confirmed: ReadonlyArray<{ details: { faxno?: string | null } | null }>): string {
  for (const m of confirmed) {
    const digits = (m.details?.faxno ?? '').replace(/\D/g, '')
    const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
    if (ten.length === 10) return ten
  }
  return DEFAULT_EXTENSION_FAX_NUMBER
}

function safeName(company: string): string {
  return company.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Company'
}

/** The 7004 exactly as it was faxed (kept in the Tax folder, hidden from the client). */
export function workingCopyName(company: string, year: number | null): string {
  return `${WORKING_COPY_PREFIX} - ${safeName(company)} - Tax Return${year ? ` ${year}` : ''}.pdf`
}

/** The document the client sees: the Form 7004 followed by the IRS fax receipt, in one file. */
export function mergedDocumentName(company: string, year: number | null): string {
  return `Form 7004 + IRS fax receipt - ${safeName(company)} - Tax Return${year ? ` ${year}` : ''}.pdf`
}

/** The Form 7004 alone, shown to the client, when Faxage never gave the receipt page (a different name from the merged document and from the working copy). */
export function form7004OnlyName(company: string, year: number | null): string {
  return `Form 7004 - ${safeName(company)} - Tax Return${year ? ` ${year}` : ''}.pdf`
}

/** The IRS fax receipt kept by itself (only when the merged document could not be built). Its own name: the return fax receipt of the same year must never collide with it. */
export function extensionReceiptName(company: string, year: number | null): string {
  return `IRS fax receipt (Form 7004) - ${safeName(company)} - Tax Return${year ? ` ${year}` : ''}.pdf`
}

export function extensionFaxReason(company: string, year: number | null): string {
  return `Form 7004 extension${year ? ` ${year}` : ''} - ${company}`
}

export function extensionFaxCover(company: string, year: number | null): string {
  return `Form 7004, application for an automatic extension of time to file the${year ? ` ${year}` : ''} tax return of ${company}.`
}

/** "2026-10-15" -> "October 15, 2026" / "15 ottobre 2026". Pure; an unreadable date comes back as is. */
export function longDate(iso: string, italian: boolean): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return iso
  const months = italian
    ? ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre']
    : ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  const month = months[Number(m[2]) - 1]
  if (!month) return iso
  const day = Number(m[3])
  return italian ? `${day} ${month} ${m[1]}` : `${month} ${day}, ${m[1]}`
}

/** The message the client gets in the portal chat when the extension is filed. `deadlineIso` is the new filing deadline (null = not stated). */
export function extensionFiledMessage(p: { italian: boolean; year: number | null; deadlineIso: string | null; /** false when no client-visible document was saved (then the message does not point to one) */ withDocument?: boolean; /** false when the document holds the form without the IRS fax receipt (then the message does not promise one) */ withReceipt?: boolean }): string {
  const y = p.year ? ` ${p.year}` : ''
  const withDocument = p.withDocument !== false
  const withReceipt = p.withReceipt !== false
  if (p.italian) {
    const deadline = p.deadlineIso ? ` La nuova scadenza è il ${longDate(p.deadlineIso, true)}.` : ''
    const docs = withDocument
      ? (withReceipt ? " Trovi il modulo presentato, con la conferma di invio all'IRS, nella sezione Documenti." : ' Trovi il modulo presentato nella sezione Documenti.')
      : ''
    return `Buone notizie: abbiamo presentato la proroga per la tua dichiarazione dei redditi${y}.${deadline}${docs}`
  }
  const deadline = p.deadlineIso ? ` The new deadline is ${longDate(p.deadlineIso, false)}.` : ''
  const docs = withDocument
    ? (withReceipt ? ' You can find the filed form, with the IRS fax confirmation, in your Documents.' : ' You can find the filed form in your Documents.')
    : ''
  return `Good news: we have filed the extension for your${y} tax return.${deadline}${docs}`
}

export interface WorkingCopyRow {
  id: string
  file_name: string | null
  drive_file_id: string | null
  created_at?: string | null
}

export interface WorkingCopy {
  documentId: string
  fileName: string
}

/** The newest working copy of this job (a document whose name starts with the working-copy prefix). Pure. */
export function pickWorkingCopy(docs: readonly WorkingCopyRow[]): WorkingCopy | null {
  const mine = docs
    .filter((d) => !!d.drive_file_id && (d.file_name ?? '').startsWith(WORKING_COPY_PREFIX))
    .sort((a, b) => (Date.parse(b.created_at ?? '') || 0) - (Date.parse(a.created_at ?? '') || 0))
  const d = mine[0]
  return d ? { documentId: d.id, fileName: d.file_name ?? 'Form 7004.pdf' } : null
}

/**
 * The address a 7004 is pre-filled with. A company with a TD office number gets the OFFICIAL address ("10225 Ulmerton Rd 3D, Largo, FL 33771", no box
 * number) whatever row is saved: it is the address on the EIN application (SS-4 line 4a) and the Articles, so the IRS's record and this form agree
 * (lib/addresses.ts, "the four addresses"). A company with no number: its saved mailing address, but NEVER the shared Largo row (that is not its
 * address); with neither, an empty form for staff to fill. Staff review it before anything is made.
 */
export interface PrefillAddress { street: string; suite: string; city: string; state: string; zip: string }

export function prefillAddress(
  mailing: { address_line1?: string | null; address_line2?: string | null; city?: string | null; state?: string | null; zip?: string | null } | null | undefined,
  suiteNumber: string | null | undefined,
): PrefillAddress {
  const official = companyOfficialRow(suiteNumber)
  if (official) return { street: official.address_line1, suite: '', city: official.city, state: official.state, zip: official.zip }
  if (mailing?.address_line1?.trim() && !isTdLargoAddressRow(mailing)) {
    return {
      street: mailing.address_line1.trim(),
      suite: (mailing.address_line2 ?? '').trim(),
      city: (mailing.city ?? '').trim(),
      state: (mailing.state ?? '').trim(),
      zip: (mailing.zip ?? '').trim(),
    }
  }
  return { street: '', suite: '', city: '', state: '', zip: '' }
}

export type ExtensionFaxState =
  /** not a single-member LLC: the box shows the plain upload box */
  | { mode: 'manual' }
  /** nothing generated yet: show the form to review and generate */
  | { mode: 'generate' }
  /** a 7004 is generated and nothing was faxed: preview it, confirm the number, send */
  | { mode: 'ready'; documentId: string; fileName: string }
  | { mode: 'unconfirmed'; at: string }
  | { mode: 'sent'; at: string; faxJobId: string | null; faxno: string | null; waitingTooLong: boolean; copy: WorkingCopy | null }
  | { mode: 'delivered'; at: string; faxJobId: string | null }
  | { mode: 'failed'; at: string; faxJobId: string | null; reason: string | null; copy: WorkingCopy | null }
  /** Faxage says it was delivered, to a number nobody has confirmed is the IRS: nothing moved; a person says whether it was the IRS */
  | { mode: 'confirm_recipient'; at: string; faxJobId: string | null; faxno: string | null; copy: WorkingCopy | null }

export interface ExtensionFaxStateInput {
  entityType: string | null
  workingCopy: WorkingCopy | null
  /** the newest fax_sent / fax_claim row of this job THAT CARRIES THE EXTENSION PURPOSE */
  latestFax: FaxLogRow | null
  /** the extension delivery-check markers of this job */
  markers: readonly MarkerRow[]
}

/** What the box shows. Pure. A fax already on record always wins over "ready": the box can never offer a plain Send on a job whose 7004 was faxed. */
export function buildExtensionFaxState(i: ExtensionFaxStateInput): ExtensionFaxState {
  if (!usesExtensionFaxBox(i.entityType)) return { mode: 'manual' }
  const fax = i.latestFax
  if (fax) {
    if (fax.action_type === 'fax_claim') return { mode: 'unconfirmed', at: fax.created_at }
    const jobId = fax.details?.job_id ?? null
    const forThisFax = (kind: string) => i.markers.find((m) => m.action_type === kind && (m.details?.job_id ?? null) === jobId)
    if (forThisFax(EXTENSION_FAX_MARKERS.confirmed)) return { mode: 'delivered', at: fax.created_at, faxJobId: jobId }
    const failed = forThisFax(EXTENSION_FAX_MARKERS.failed)
    if (failed) return { mode: 'failed', at: fax.created_at, faxJobId: jobId, reason: failed.details?.reason ?? null, copy: i.workingCopy }
    const unverified = forThisFax(EXTENSION_FAX_MARKERS.recipientUnverified)
    if (unverified && !forThisFax(EXTENSION_FAX_MARKERS.recipientConfirmed)) {
      return { mode: 'confirm_recipient', at: fax.created_at, faxJobId: jobId, faxno: unverified.details?.faxno ?? fax.details?.faxno ?? null, copy: i.workingCopy }
    }
    return {
      mode: 'sent',
      at: fax.created_at,
      faxJobId: jobId,
      faxno: fax.details?.faxno ?? null,
      waitingTooLong: !!forThisFax(EXTENSION_FAX_MARKERS.stale),
      copy: i.workingCopy,
    }
  }
  if (i.workingCopy) return { mode: 'ready', documentId: i.workingCopy.documentId, fileName: i.workingCopy.fileName }
  return { mode: 'generate' }
}
