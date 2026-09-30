/**
 * Real (service-role) implementations of the signing steps in sign-public-offer.ts.
 * Kept separate so the orchestrator stays pure and fully unit-tested.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { processOfferSigned } from '@/lib/offers/process-offer-signed'
import { processAgreementSigned } from '@/lib/offers/process-agreement-signed'
import type { SignDeps } from '@/lib/offers/sign-public-offer'
import { sniffFileKind, MAX_SIGNED_PDF_BYTES, type SniffedKind } from '@/lib/offers/upload-sniff'

/**
 * Is the uploaded object really there, within the size cap, and really one of the
 * allowed file kinds (by its first bytes)? A bad object is removed so it can never be
 * recorded as a signed contract or a proof of payment.
 */
export async function verifyStoredUpload(
  bucket: string,
  path: string,
  allowed: SniffedKind[],
  maxBytes: number,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin.storage.from(bucket).download(path)
  if (error || !data) return false
  const size = data.size
  const head = new Uint8Array(await data.slice(0, 16).arrayBuffer())
  const kind = sniffFileKind(head)
  if (size <= 0 || size > maxBytes || !kind || !allowed.includes(kind)) {
    await supabaseAdmin.storage.from(bucket).remove([path])
    return false
  }
  return true
}

export const realSignDeps: SignDeps = {
  storageObjectExists: (bucket, path) => verifyStoredUpload(bucket, path, ['pdf'], MAX_SIGNED_PDF_BYTES),
  async insertContract(row) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabaseAdmin as any).from('contracts').insert(row).select('id').single()
    return { id: data?.id ?? null, error: error ? error.message : null }
  },
  async deleteContract(id) {
    await supabaseAdmin.from('contracts').delete().eq('id', id)
  },
  async contractCount(token) {
    const { count } = await supabaseAdmin
      .from('contracts')
      .select('id', { count: 'exact', head: true })
      .eq('offer_token', token)
    return count ?? 0
  },
  async flipOfferSigned(token, update, fromStatuses) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabaseAdmin as any)
      .from('offers')
      .update(update)
      .eq('token', token)
      .in('status', fromStatuses as string[])
      .select('id')
    return { changed: Array.isArray(data) ? data.length : 0, error: error ? error.message : null }
  },
  processOfferSigned,
  processAgreementSigned,
  now: () => new Date(),
}
