/**
 * Server-side check of the drawn signature a closure form names (Company Closure, dev job a6bbea09). The wizard only sends a PATH; before the
 * server records anyone's consent for it, it must be a real, small PNG that THIS client uploaded for THIS closure:
 *   - the file sits in the client's own wizard folder (their company's or their own id) — never another person's folder;
 *   - the object exists, is at most MAX_SIGNATURE_BYTES, starts like a PNG and is a drawing-sized picture.
 * Server only (reads the wizard bucket).
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { looksLikePng, readPngSize, MAX_SIGNATURE_BYTES, MAX_SIGNATURE_PIXELS } from '@/lib/closure/signature-consent'

const BUCKET = 'onboarding-uploads' // the shared wizard upload bucket (app/api/portal/wizard-upload-url)

/** Plain, bilingual (the server does not know the client's language): a client whose signature fails is asked to draw it again. */
export const SIGNATURE_UNREADABLE_SENTENCE = 'Your signature could not be read — please draw it again. / Non è stato possibile leggere la tua firma — disegnala di nuovo.'

/** The folder names a wizard upload can sit in for this caller (an upload identifier is sanitised the way wizard-upload-url does it). */
export function ownWizardFolders(ids: Array<string | null | undefined>): string[] {
  return Array.from(new Set(ids.filter((x): x is string => typeof x === 'string' && x.length > 0).map((x) => x.replace(/[^a-zA-Z0-9@._-]/g, '_'))))
}

export type SignatureCheck = { ok: true } | { ok: false; error: string }

export async function verifyClosureSignatureFile(path: string, ownFolders: string[]): Promise<SignatureCheck> {
  const m = /^closure\/([^/]+)\/(signature_image_[^/]+)$/.exec(path)
  if (!m || !ownFolders.includes(m[1])) return { ok: false, error: SIGNATURE_UNREADABLE_SENTENCE }
  const [, folder, file] = m
  try {
    const { data: items, error: listErr } = await supabaseAdmin.storage.from(BUCKET).list(`closure/${folder}`, { search: file, limit: 10 })
    if (listErr) return { ok: false, error: SIGNATURE_UNREADABLE_SENTENCE }
    const item = (items ?? []).find((o) => o.name === file)
    const size = Number((item?.metadata as { size?: number } | null | undefined)?.size ?? NaN)
    if (!item || !Number.isFinite(size) || size > MAX_SIGNATURE_BYTES) return { ok: false, error: SIGNATURE_UNREADABLE_SENTENCE }
    const { data: blob, error } = await supabaseAdmin.storage.from(BUCKET).download(path)
    if (error || !blob) return { ok: false, error: SIGNATURE_UNREADABLE_SENTENCE }
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const dims = readPngSize(bytes)
    if (bytes.length > MAX_SIGNATURE_BYTES || !looksLikePng(bytes) || !dims || dims.width > MAX_SIGNATURE_PIXELS || dims.height > MAX_SIGNATURE_PIXELS) {
      return { ok: false, error: SIGNATURE_UNREADABLE_SENTENCE }
    }
    return { ok: true }
  } catch {
    return { ok: false, error: SIGNATURE_UNREADABLE_SENTENCE }
  }
}
