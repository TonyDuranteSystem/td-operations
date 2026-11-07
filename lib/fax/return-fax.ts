/**
 * Tax Return "Signed" step — fax the signed return to the IRS from the workspace (plan item 6, dev job 6f555c9f, 2026-11-07).
 *
 * The pure rules, no database and no network, so every decision the fax box and the delivery check make is tested on its own:
 *  - who gets the box (single-member companies: the return is FAXED; a multi-member return is e-filed outside, a C-corp has its own route),
 *  - which file is faxed (the signed copy of THIS job's e-sign document, found through the job — never a guess by name),
 *  - what the box shows (ready / waiting / delivered / failed / no copy / not for this company),
 *  - what a Faxage answer means (delivered, failed, still waiting, waiting too long).
 *
 * The send itself is the shared fax engine (POST /api/tools/fax/send: one claim row per Send, a repeat needs an explicit confirm);
 * the delivery check lives in lib/fax/return-fax-delivery.ts.
 */

import type { FaxDeliveryStatus } from '@/lib/fax/faxage'
import { isIrsEinFaxNumber } from '@/lib/fax/irs-ein-numbers'
import { isStorePointer } from '@/lib/crm-store/document-pointer'

/**
 * The IRS fax line staff use for a signed single-member return (digits only). Verified on production 2026-11-07: 133 faxes to this number,
 * 2026-06-17 to 2026-10-15, all sent by hand from the Fax tool. It is NOT one of the IRS EIN (SS-4) lines.
 */
export const IRS_RETURN_FAX_NUMBER = '8558877737'

/** Companies whose signed return is FAXED by us (accounts.entity_type). Multi-member returns are e-filed outside; a C-corp election is not decided yet. */
export const RETURN_FAX_ENTITY_TYPES: readonly string[] = ['Single Member LLC']

/** A fax still "pending" at Faxage this long after it was sent is reported to staff (it is still checked on every run). */
export const RETURN_FAX_STALE_MINUTES = 120

/** The activity-log markers the delivery check writes (one per fax job id, so a re-run never repeats an alert or a filing). */
export const RETURN_FAX_MARKERS = {
  confirmed: 'return_fax_confirmed',
  failed: 'return_fax_failed',
  stale: 'return_fax_stale',
} as const

export function usesReturnFaxBox(entityType: string | null | undefined): boolean {
  return !!entityType && RETURN_FAX_ENTITY_TYPES.includes(entityType)
}

/**
 * True when a fax went to the IRS return line ("1 (855) 887-7737", "855-887-7737", "+18558877737" … all count). Only such a fax files the job when it is
 * delivered: a test fax to another number, or a mistyped number, is delivered to someone else and must never file a client's return.
 */
export function isReturnFaxLine(faxno: string | null | undefined): boolean {
  if (typeof faxno !== 'string') return false
  let digits = faxno.replace(/\D/g, '')
  if (digits.length === 11 && digits.charAt(0) === '1') digits = digits.slice(1)
  return digits === IRS_RETURN_FAX_NUMBER
}

/** True when staff typed one of the IRS EIN (SS-4) lines: a signed return must never go there. */
export function isEinLineForReturn(faxno: string | null | undefined): boolean {
  return isIrsEinFaxNumber(faxno)
}

export type ReturnFaxDecision = 'delivered' | 'failed' | 'pending' | 'stale'

/** What a Faxage status means for a return fax sent at `sentAtIso`. Anything not clearly delivered or failed is waiting; waiting too long is reported. Pure. */
export function decideReturnFaxOutcome(status: FaxDeliveryStatus, sentAtIso: string | null | undefined, nowMs: number): ReturnFaxDecision {
  if (status === 'delivered') return 'delivered'
  if (status === 'failed') return 'failed'
  const sentMs = sentAtIso ? Date.parse(sentAtIso) : NaN
  if (!Number.isNaN(sentMs) && nowMs - sentMs > RETURN_FAX_STALE_MINUTES * 60_000) return 'stale'
  return 'pending'
}

export function returnFaxReason(company: string, year: number | null): string {
  return `Tax Return${year ? ` ${year}` : ''} filing - ${company}`
}

export function returnFaxCover(company: string, year: number | null): string {
  return `Signed tax return${year ? ` ${year}` : ''} for ${company}.`
}

export function returnFaxReceiptName(company: string, year: number | null): string {
  const safe = company.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Company'
  return `Fax Confirmation - ${safe} - Tax Return${year ? ` ${year}` : ''}.pdf`
}

export interface SignedEnvelopeRow {
  id: string
  status: string
  completed_at: string | null
  signed_pdf_drive_id: string | null
  document_name: string | null
}
export interface DocumentRowLite {
  id: string
  file_name: string | null
  drive_file_id: string | null
}

export type SignedCopy =
  | { kind: 'ready'; documentId: string; fileName: string; envelopeId: string; completedCount: number }
  | { kind: 'none' | 'unfiled' | 'not_faxable'; reason: string; documentId?: string; fileName?: string }

/**
 * The signed copy of THIS job: the newest COMPLETED e-sign document tied to the job (esign_envelopes.service_delivery_id), found in the company's
 * documents through the pointer the signing step wrote when it filed the signed PDF. Only a copy in the company's storage can be faxed by the engine
 * (a copy kept outside the storage is shown but not offered). Pure.
 */
export function pickSignedCopy(envelopes: readonly SignedEnvelopeRow[], docs: readonly DocumentRowLite[]): SignedCopy {
  const completed = envelopes
    .filter((e) => e.status === 'completed')
    .sort((a, b) => (Date.parse(b.completed_at ?? '') || 0) - (Date.parse(a.completed_at ?? '') || 0))
  const env = completed[0]
  if (!env) return { kind: 'none', reason: 'No signed copy of this return was found for this job. Send the return for signature from the Preparation step first.' }
  const pointer = env.signed_pdf_drive_id
  if (!pointer) return { kind: 'unfiled', reason: 'The client has signed, but the signed copy is not filed in the company storage yet. Try again in a minute.' }
  const doc = docs.find((d) => d.drive_file_id === pointer)
  if (!doc) return { kind: 'unfiled', reason: 'The signed copy is filed, but its entry in the company documents was not found. Use the Fax tool and attach the signed copy.' }
  if (!isStorePointer(pointer)) {
    return { kind: 'not_faxable', documentId: doc.id, fileName: doc.file_name ?? 'Signed return.pdf', reason: 'The signed copy is kept outside the company storage, so it cannot be faxed from here. Use the Fax tool and attach it.' }
  }
  return { kind: 'ready', documentId: doc.id, fileName: doc.file_name ?? 'Signed return.pdf', envelopeId: env.id, completedCount: completed.length }
}

export interface FaxLogRow {
  id: string
  action_type: string
  created_at: string
  details: { job_id?: string; faxno?: string } | null
}
export interface MarkerRow {
  action_type: string
  created_at: string
  details: { job_id?: string; reason?: string } | null
}

export type ReturnFaxState =
  | { mode: 'manual'; reason: string }
  | { mode: 'no_copy'; reason: string; fileName?: string }
  | { mode: 'ready'; documentId: string; fileName: string; moreCopies: boolean }
  | { mode: 'unconfirmed'; at: string }
  /** `toIrsLine` false = the last fax went to some other number: it does NOT file the job by itself */
  | { mode: 'sent'; at: string; faxJobId: string | null; faxno: string | null; toIrsLine: boolean; waitingTooLong: boolean; copy: { documentId: string; fileName: string } | null }
  | { mode: 'delivered'; at: string; faxJobId: string | null }
  | { mode: 'failed'; at: string; faxJobId: string | null; reason: string | null; documentId: string | null; fileName: string | null }

export interface ReturnFaxStateInput {
  entityType: string | null
  signedCopy: SignedCopy
  /** The newest fax_sent / fax_claim row of this job (any other row types are ignored). */
  latestFax: FaxLogRow | null
  /** The delivery-check markers of this job. */
  markers: readonly MarkerRow[]
}

/** What the fax box shows. Pure. A fax already on record always wins over "ready": the box can never offer a plain Send on a job that was faxed. */
export function buildReturnFaxState(i: ReturnFaxStateInput): ReturnFaxState {
  if (!usesReturnFaxBox(i.entityType)) {
    return { mode: 'manual', reason: 'This company is not a single-member LLC. Its signed return is not faxed from here: use the Fax tool, or mark it filed when it has been filed another way.' }
  }
  const fax = i.latestFax
  if (fax) {
    if (fax.action_type === 'fax_claim') return { mode: 'unconfirmed', at: fax.created_at }
    const jobId = fax.details?.job_id ?? null
    const forThisFax = (kind: string) => i.markers.find((m) => m.action_type === kind && (m.details?.job_id ?? null) === jobId)
    if (forThisFax(RETURN_FAX_MARKERS.confirmed)) return { mode: 'delivered', at: fax.created_at, faxJobId: jobId }
    const failed = forThisFax(RETURN_FAX_MARKERS.failed)
    if (failed) {
      const copy = i.signedCopy
      return {
        mode: 'failed',
        at: fax.created_at,
        faxJobId: jobId,
        reason: failed.details?.reason ?? null,
        documentId: copy.kind === 'ready' ? copy.documentId : null,
        fileName: copy.kind === 'ready' ? copy.fileName : null,
      }
    }
    const faxno = fax.details?.faxno ?? null
    return {
      mode: 'sent',
      at: fax.created_at,
      faxJobId: jobId,
      faxno,
      toIrsLine: isReturnFaxLine(faxno),
      waitingTooLong: !!forThisFax(RETURN_FAX_MARKERS.stale),
      copy: i.signedCopy.kind === 'ready' ? { documentId: i.signedCopy.documentId, fileName: i.signedCopy.fileName } : null,
    }
  }
  const copy = i.signedCopy
  if (copy.kind !== 'ready') return { mode: 'no_copy', reason: copy.reason, fileName: copy.fileName }
  return { mode: 'ready', documentId: copy.documentId, fileName: copy.fileName, moreCopies: copy.completedCount > 1 }
}
