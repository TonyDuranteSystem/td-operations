/**
 * Browser-side calls for the public offer pages (N0, dev job f907220c).
 *
 * The offer, contract and agreement pages used to read and write the database
 * directly with the public key. Every read and write now goes through the server
 * routes under /api/offers, carrying the offer's access code (or, for a renewal
 * agreement, the portal pass / grant). This module is the ONE place the pages call
 * them from, so the credential is always sent the same way and a server error always
 * reaches the page (R099) instead of being swallowed.
 *
 * Client-safe: no server imports.
 */

import { SigningFailure, signingLang } from '@/lib/public-forms/signing-failures'

export interface OfferCredential {
  token: string
  /** Offer access code (from the /offer/<token>/<code> link, or ?c= on the contract page). */
  code?: string
  /** Renewal agreement portal pass or grant. */
  pass?: string
  /** Asks for staff preview — honoured only for a real admin/team session. */
  preview?: boolean
}

export class OfferApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function post<T>(path: string, cred: OfferCredential, extra: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: cred.token,
      code: cred.code || '',
      pass: cred.pass || '',
      preview: cred.preview ? 'td' : undefined,
      ...extra,
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new OfferApiError(typeof data?.error === 'string' && data.error ? data.error : 'Something went wrong. Please try again.', res.status)
  }
  return data as T
}

export interface OfferViewResponse {
  kind: 'offer' | 'renewal'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  offer: any
  staffPreview: boolean
  grant?: string | null
}

export function fetchOfferView(cred: OfferCredential): Promise<OfferViewResponse> {
  return post<OfferViewResponse>('/api/offers/view', cred)
}

/** Best-effort view counter — never throws. */
export async function trackOfferOpen(cred: OfferCredential): Promise<void> {
  try { await post('/api/offers/track-open', cred) } catch { /* a missed view count must never block the page */ }
}

export function saveOfferSelection(cred: OfferCredential, selected: string[]): Promise<{ ok: true; selected_services: string[] }> {
  return post('/api/offers/save-selection', cred, { selected_services: selected })
}

export function offerGateInfo(token: string): Promise<{ language: 'en' | 'it' }> {
  return post('/api/offers/gate', { token }, { action: 'info' })
}

export function offerGateCheck(token: string, email: string, preview = false): Promise<{ code: string }> {
  return post('/api/offers/gate', { token, preview }, { email })
}

/**
 * Upload a file through a one-time link the server issues. Returns the storage path
 * the server chose. `purpose` = the signed contract PDF or a wire-transfer receipt.
 */
export async function uploadOfferFile(
  cred: OfferCredential,
  purpose: 'signed_pdf' | 'wire_receipt',
  file: Blob,
  fileName: string,
): Promise<string> {
  const { signedUrl, path } = await post<{ signedUrl: string; path: string }>('/api/offers/upload-url', cred, { purpose, file_name: fileName })
  const put = await fetch(signedUrl, {
    method: 'PUT',
    headers: { 'Content-Type': (file as File).type || (purpose === 'signed_pdf' ? 'application/pdf' : 'application/octet-stream') },
    body: file,
  })
  if (!put.ok) throw new OfferApiError('document_upload', put.status)
  return path
}

export interface SignResponse {
  ok: true
  alreadySigned: boolean
  bankAmount: string | null
  planRefusal: string | null
  invoiceNumber: string | null
}

export function signOffer(cred: OfferCredential, pdfPath: string, fields: Record<string, unknown>): Promise<SignResponse> {
  return post<SignResponse>('/api/offers/sign', cred, { pdf_path: pdfPath, fields })
}

/** A server message meant for the client, shown as-is on the signing screen. */
class ClientFacingOfferError extends Error {
  readonly clientFacing = true as const
}

/**
 * Upload the signed PDF, then sign on the server. Every failure becomes a client-facing
 * error the signing screens already know how to show: the three stage codes map to the
 * existing bilingual "NOT signed / signed but not marked" messages; any other server
 * sentence ("This offer has expired…") is shown verbatim.
 */
export async function uploadAndSignOffer(
  cred: OfferCredential,
  pdf: Blob,
  fileName: string,
  fields: Record<string, unknown>,
  lang: string | null | undefined,
): Promise<SignResponse> {
  const l = signingLang(lang)
  let pdfPath: string
  try {
    pdfPath = await uploadOfferFile(cred, 'signed_pdf', pdf, fileName)
  } catch (e) {
    if (e instanceof OfferApiError && e.message !== 'document_upload' && e.status !== 500) throw new ClientFacingOfferError(e.message)
    throw new SigningFailure('document_upload', l)
  }
  try {
    return await signOffer(cred, pdfPath, fields)
  } catch (e) {
    const msg = e instanceof Error ? e.message : ''
    if (msg === 'document_upload' || msg === 'record' || msg === 'status') throw new SigningFailure(msg, l)
    if (e instanceof OfferApiError && e.status < 500) throw new ClientFacingOfferError(msg)
    throw new SigningFailure('record', l)
  }
}

export async function submitWireReceipt(cred: OfferCredential, file: File): Promise<void> {
  const path = await uploadOfferFile(cred, 'wire_receipt', file, file.name)
  await post('/api/offers/wire-receipt', cred, { path })
}

export function createOfferCheckout(cred: OfferCredential): Promise<{ checkoutUrl: string; label: string }> {
  return post('/api/offers/create-checkout', cred)
}

/** Query string the contract page needs to reach the same credential. */
export function contractCredentialQuery(cred: OfferCredential): string {
  const q = new URLSearchParams()
  if (cred.code) q.set('c', cred.code)
  if (cred.pass) q.set('pass', cred.pass)
  if (cred.preview) q.set('preview', 'td')
  return q.toString()
}
