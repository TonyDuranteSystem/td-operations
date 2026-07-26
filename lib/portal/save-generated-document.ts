/**
 * Persist a document a client generated AND SIGNED themselves (e.g. a
 * distribution certificate) into their portal Documents folder.
 *
 * Product rule (Antonio 2026-07-26): the file must SURFACE in the client's
 * Documents folder (Drive + a portal-visible record) so it's findable/
 * downloadable — but the person who made it is NOT alerted (they just signed
 * it, they know). Any CO-OWNERS of the company are alerted normally.
 *
 * How "surface, don't alert the maker" is achieved:
 *  - the record is portal-visible and stamped `client_notified_at` so it is
 *    eligible for the Documents-tab "new" pulse (getUnopenedDocsCount);
 *  - a `portal_document_views` row is pre-inserted for the MAKER, so the pulse
 *    is already cleared for them — it shows in their folder without flagging
 *    "new" and without any push/bell/email to them;
 *  - every OTHER contact on the account (co-owners) gets a per-contact
 *    new-document notification (push + bell), so they're alerted normally.
 *    Single-owner LLCs (the common case) have no co-owners → no alert at all.
 *
 * The record itself is written through the canonical `autoSaveDocument` path so
 * it gets the clickable `drive_link`, the confidence-CHECK-safe value and the
 * per-file idempotency guard for free. We deliberately do NOT call
 * `notifyClientsOfNewDocument`: that fires an account-scoped alert which would
 * reach the maker too.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { uploadBinaryToDrive } from '@/lib/google-drive'
import { autoSaveDocument } from '@/lib/portal/auto-save-document'
import { createPortalNotification } from '@/lib/portal/notifications'
import { isNewDocumentAlertEnabled } from '@/lib/portal/document-alerts'
import { isItalian } from '@/lib/locale'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

const COPY = {
  en: { title: 'New document available', body: (n: string) => `${n} has been added to your portal.` },
  it: { title: 'Nuovo documento disponibile', body: (n: string) => `${n} è stato aggiunto al tuo portale.` },
}

export interface SaveGeneratedDocumentParams {
  accountId: string
  /** The contact who generated + signed it — the MAKER (won't be alerted). */
  contactId: string
  fileBuffer: Buffer
  fileName: string
  /** Human doc type label, e.g. "Distribution Resolution". */
  documentType: string
  /** Documents category: 1=Company (default), 3=Tax, etc. */
  category?: number
  mimeType?: string
}

export interface SaveGeneratedDocumentResult {
  success: boolean
  documentId?: string
  driveFileId?: string
  coOwnersAlerted?: number
  error?: string
}

export async function saveSignedGeneratedDocument(
  params: SaveGeneratedDocumentParams,
): Promise<SaveGeneratedDocumentResult> {
  const { accountId, contactId, fileBuffer, fileName, documentType } = params
  const mimeType = params.mimeType || 'application/pdf'
  const category = params.category ?? 1 // Company

  const { data: account } = await db
    .from('accounts')
    .select('drive_folder_id, company_name')
    .eq('id', accountId)
    .single()

  if (!account?.drive_folder_id) {
    return { success: false, error: 'Account has no Drive folder' }
  }

  // 1. Drive
  let driveFileId: string
  try {
    const driveFile = await uploadBinaryToDrive(fileName, fileBuffer, mimeType, account.drive_folder_id)
    driveFileId = driveFile.id as string
  } catch (err) {
    return { success: false, error: `Drive upload failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  // 2. Portal-visible document record via the canonical path (sets drive_link,
  //    confidence, and dedups on drive_file_id).
  const saved = await autoSaveDocument({
    accountId,
    contactId,
    fileName,
    documentType,
    category,
    driveFileId,
    portalVisible: true,
  })
  if (saved.error || !saved.id) {
    // The Drive file may be orphaned (upload succeeded, record didn't) — the
    // caller surfaces this so ops can see it; per-file dedup means a retry with
    // the same id won't double-insert.
    return { success: false, error: `Document record failed: ${saved.error || 'no id'}`, driveFileId }
  }
  const documentId = saved.id

  // 3. Stamp it "new" (client_notified_at) so it is pulse-eligible for co-owners,
  //    and keep notify_client on. autoSaveDocument doesn't set these.
  try {
    await db
      .from('documents')
      .update({ client_notified_at: new Date().toISOString(), notify_client: true })
      .eq('id', documentId)
      .is('client_notified_at', null)
  } catch (err) {
    console.warn('[save-generated-document] new-stamp failed:', err instanceof Error ? err.message : String(err))
  }

  // 4. Pre-mark the MAKER as having "seen" it → no "new" pulse and no alert for
  //    them; it simply appears in their Documents folder.
  try {
    await db
      .from('portal_document_views')
      .upsert({ document_id: documentId, contact_id: contactId }, { onConflict: 'document_id,contact_id' })
  } catch (err) {
    console.warn('[save-generated-document] view pre-mark failed:', err instanceof Error ? err.message : String(err))
  }

  // 5. Alert co-owners (every OTHER contact on the account) — never the maker.
  //    Honors the same global kill switch as the staff new-document alert.
  let coOwnersAlerted = 0
  try {
    if (await isNewDocumentAlertEnabled()) {
      const { data: links } = await db.from('account_contacts').select('contact_id').eq('account_id', accountId)
      const coOwnerIds = Array.from(
        new Set(
          ((links ?? []) as Array<{ contact_id: string }>)
            .map(l => l.contact_id)
            .filter(id => id && id !== contactId),
        ),
      )

      for (const coId of coOwnerIds) {
        const { data: coContact } = await db.from('contacts').select('language').eq('id', coId).single()
        const locale = isItalian(coContact?.language) ? 'it' : 'en'
        const c = COPY[locale]
        await createPortalNotification({
          contact_id: coId,
          type: 'new_document',
          title: c.title,
          body: c.body(fileName),
          link: '/portal/documents',
        })
        coOwnersAlerted++
      }
    }
  } catch (err) {
    // Non-fatal: the document is saved + visible; a co-owner alert failure must
    // not fail the save.
    console.warn('[save-generated-document] co-owner alert failed:', err instanceof Error ? err.message : String(err))
  }

  return { success: true, documentId, driveFileId, coOwnersAlerted }
}
