/**
 * The record that a document was filed in Storage on purpose while a workspace step was waiting for it (dev job e3215801) — written by BOTH
 * doors (the Storage upload route and the contact page's upload route), so the wording and the columns are the same.
 *
 * It is tied to the case AND to the person / company the case belongs to (the activity lists look up by those). It never undoes the save:
 * a note that cannot be written is reported back ("failed") so the staff member is told and can note it by hand.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'
import type { WaitingWorkspaceStep } from '@/lib/flows/storage-step-rules'

export async function recordStorageOnlyFiling(input: {
  waiting: WaitingWorkspaceStep[]
  /** The staff member's email ("luca@tonydurante.us" -> actor "dashboard:luca"). */
  actorEmail: string | null | undefined
  /** The stored file (Storage file id, or the "store:<id>" pointer). */
  fileId: string | null | undefined
  fileName: string
  documentType: string | null
}): Promise<'recorded' | 'failed'> {
  let note: 'recorded' | 'failed' = 'recorded'
  for (const h of input.waiting) {
    const asks = h.asks.charAt(0).toUpperCase() + h.asks.slice(1)
    const summary = h.matchedBy === 'type'
      ? `${asks} filed in Storage only — ${h.who}'s ${h.serviceType} case is still at "${h.stage}" (the workspace step was not done)`
      : `A file typed "Other document" was filed in ${h.who}'s storage, where this step's documents are kept, while the ${h.serviceType} case is at "${h.stage}" waiting for ${h.asks} (the workspace step was not done)`
    try {
      const { error } = await supabaseAdmin.from('action_log').insert({
        actor: `dashboard:${input.actorEmail?.split('@')[0] ?? 'unknown'}`,
        action_type: 'storage_filed_workspace_document',
        table_name: 'store_files',
        record_id: input.fileId ?? null,
        service_delivery_id: h.sdId,
        contact_id: h.contactId,
        account_id: h.accountId,
        summary,
        details: { file_name: input.fileName, stage: h.stage, workspace: h.workspacePath, document_type: input.documentType, matched_by: h.matchedBy },
      })
      if (error) throw new Error(error.message)
    } catch (e) {
      note = 'failed'
      console.error('[crm-store] could not record the Storage-only filing:', e instanceof Error ? e.message : e)
    }
  }
  return note
}
