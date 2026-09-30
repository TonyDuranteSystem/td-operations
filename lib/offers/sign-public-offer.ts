/**
 * Server-side signing of an offer or an annual renewal agreement (N0, dev job f907220c).
 *
 * ORDER — artifact → record → status → follow-up, each gating the next (the order the
 * browser used; the council required it be kept, NOT "claim signed first"):
 *   1. the signed PDF must already be in storage, under a path the server issued;
 *   2. the contracts row is inserted;
 *   3. the status flips with a CONDITIONAL update (only from a signable status) — a real
 *      UPDATE, so the brain-offer-signed trigger keeps firing. Of two concurrent signs only
 *      one flips; the loser removes the contracts row it just wrote and returns success;
 *   4. the signing follow-up (activation, invoice, archive / renewal invoice) runs
 *      in-process. It is idempotent, and a failure here does not undo the signature — it
 *      is logged and re-run on the client's retry.
 *
 * RESUMABLE: a retry on an offer that is already signed (lost response, timeout after
 * step 3) is not an error. It re-checks the contracts row and re-runs the follow-up, so
 * whatever did not finish the first time finishes now, and the client gets the same
 * success answer.
 *
 * All I/O is injected so every step's failure-and-retry is unit-tested
 * (tests/unit/sign-public-offer.test.ts).
 */

import {
  offerSignRefusal,
  sanitizeContractFields,
  signingOfferUpdate,
  signKindFor,
  isOwnSignedPdfPath,
  SIGNABLE_OFFER_STATUSES,
} from '@/lib/offers/public-signing'

export interface SignDeps {
  storageObjectExists: (bucket: string, path: string) => Promise<boolean>
  insertContract: (row: Record<string, unknown>) => Promise<{ id: string | null; error: string | null }>
  deleteContract: (id: string) => Promise<void>
  contractCount: (token: string) => Promise<number>
  /** UPDATE offers SET … WHERE token AND status IN (signable) — returns rows changed. */
  flipOfferSigned: (token: string, update: Record<string, unknown>, fromStatuses: readonly string[]) => Promise<{ changed: number; error: string | null }>
  processOfferSigned: (token: string) => Promise<{ status: number; body: Record<string, unknown> }>
  processAgreementSigned: (token: string) => Promise<{ status: number; body: Record<string, unknown> }>
  now: () => Date
}

export interface SignResult {
  error: string | null
  status: number
  alreadySigned: boolean
  /** Wire amount now on the offer (main contracts), or null. */
  bankAmount: string | null
  /** Set when the payment plan disagrees with the offer — the page quotes no figure. */
  planRefusal: string | null
  /** Renewal: the 1st-installment invoice number, used as the wire reference. */
  invoiceNumber: string | null
}

function fail(status: number, error: string): SignResult {
  return { error, status, alreadySigned: false, bankAmount: null, planRefusal: null, invoiceNumber: null }
}

const SIGNED_BUCKET = 'signed-contracts'

async function followUpOffer(deps: SignDeps, token: string): Promise<void> {
  try {
    const r = await deps.processOfferSigned(token)
    if (r.status >= 400) console.error(`[sign-offer] follow-up returned ${r.status} for ${token}:`, r.body?.error)
  } catch (e) {
    console.error(`[sign-offer] follow-up threw for ${token}:`, e instanceof Error ? e.message : e)
  }
}

export async function signPublicOffer(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: { offer: any; fields: Record<string, unknown> | null | undefined; pdfPath: unknown },
  deps: SignDeps,
): Promise<SignResult> {
  const { offer } = input
  const token = String(offer?.token || '')
  const kind = signKindFor(offer?.contract_type)
  if (kind === 'renewal') {
    // Legacy offer rows typed 'renewal' (none open) — renewals are signed from annual_agreements.
    return fail(409, 'This agreement cannot be signed here. Please open it from your client portal.')
  }

  // RESUME: already signed — make sure the record exists and the follow-up ran.
  if (offer?.status === 'signed' || offer?.status === 'completed') {
    if ((await deps.contractCount(token)) === 0) {
      if (!isOwnSignedPdfPath(token, input.pdfPath) || !(await deps.storageObjectExists(SIGNED_BUCKET, input.pdfPath))) {
        return fail(409, 'This offer is already signed. Please contact us if you need a copy of your contract.')
      }
      const row = buildRow(offer, kind, input.fields, input.pdfPath, deps.now())
      const ins = await deps.insertContract(row)
      if (ins.error) return fail(500, 'record')
    }
    await followUpOffer(deps, token)
    return { error: null, status: 200, alreadySigned: true, bankAmount: offer?.bank_details?.amount ?? null, planRefusal: null, invoiceNumber: null }
  }

  const refusal = offerSignRefusal(offer, deps.now())
  if (refusal) return fail(409, refusal)

  if (!isOwnSignedPdfPath(token, input.pdfPath)) return fail(400, 'document_upload')
  if (!(await deps.storageObjectExists(SIGNED_BUCKET, input.pdfPath))) return fail(400, 'document_upload')

  const row = buildRow(offer, kind, input.fields, input.pdfPath, deps.now())
  const ins = await deps.insertContract(row)
  if (ins.error || !ins.id) return fail(500, 'record')

  const { update, planRefusal } = signingOfferUpdate(offer, kind)
  const flip = await deps.flipOfferSigned(token, { status: 'signed', ...update }, SIGNABLE_OFFER_STATUSES)
  if (flip.error) {
    // The signature IS stored (PDF + contracts row); only the status did not move.
    return fail(500, 'status')
  }
  if (flip.changed === 0) {
    // Lost a race to a concurrent sign (or the status moved under us): the winner owns
    // the record. Drop the duplicate row this request wrote, then resume like a retry.
    await deps.deleteContract(ins.id)
    await followUpOffer(deps, token)
    return { error: null, status: 200, alreadySigned: true, bankAmount: null, planRefusal: null, invoiceNumber: null }
  }

  await followUpOffer(deps, token)
  const bank = update.bank_details as { amount?: string } | undefined
  return {
    error: null,
    status: 200,
    alreadySigned: false,
    bankAmount: bank?.amount ?? offer?.bank_details?.amount ?? null,
    planRefusal,
    invoiceNumber: null,
  }
}

function buildRow(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  offer: any,
  kind: ReturnType<typeof signKindFor>,
  fields: Record<string, unknown> | null | undefined,
  pdfPath: string,
  now: Date,
): Record<string, unknown> {
  return {
    ...sanitizeContractFields(fields, kind),
    offer_token: String(offer.token),
    signed_at: now.toISOString(),
    pdf_path: pdfPath,
    status: 'signed',
  }
}

/**
 * Renewal agreements: record + the in-process follow-up, which itself flips the
 * agreement to signed (service role) and creates the 1st-installment invoice.
 */
export async function signRenewalAgreement(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: { agreement: any; fields: Record<string, unknown> | null | undefined; pdfPath: unknown },
  deps: SignDeps,
): Promise<SignResult> {
  const { agreement } = input
  const token = String(agreement?.token || '')
  const already = agreement?.status === 'signed' || agreement?.status === 'completed'

  if (!already || (await deps.contractCount(token)) === 0) {
    if (!isOwnSignedPdfPath(token, input.pdfPath) || !(await deps.storageObjectExists(SIGNED_BUCKET, input.pdfPath))) {
      return already
        ? fail(409, 'This agreement is already signed. Please contact us if you need a copy.')
        : fail(400, 'document_upload')
    }
    const ins = await deps.insertContract(buildRow(agreement, 'renewal', input.fields, input.pdfPath, deps.now()))
    if (ins.error) return fail(500, 'record')
  }

  let invoiceNumber: string | null = null
  try {
    const r = await deps.processAgreementSigned(token)
    if (r.status >= 400) console.error(`[sign-renewal] follow-up returned ${r.status} for ${token}:`, r.body?.error)
    else invoiceNumber = typeof r.body?.invoice_number === 'string' ? r.body.invoice_number : null
  } catch (e) {
    console.error(`[sign-renewal] follow-up threw for ${token}:`, e instanceof Error ? e.message : e)
  }
  return { error: null, status: 200, alreadySigned: already, bankAmount: null, planRefusal: null, invoiceNumber }
}
