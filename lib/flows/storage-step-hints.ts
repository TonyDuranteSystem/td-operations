/**
 * "A workspace step is waiting for this document" — the DATABASE lookup (dev job e3215801). The rules (which step waits for which
 * document, what to do in the workspace) are in ./storage-step-rules and are re-exported here, so server code has one import.
 *
 * For a file about to be saved in Storage this finds the OPEN cases of the same person / company that have a workspace step waiting for
 * exactly this kind of document. The Storage page then asks staff, in a pop-up, to open the workspace — or to save in Storage only, on
 * purpose; the upload route repeats the lookup as a backstop.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { STORAGE_STEP_HINTS, typeCouldWait, couldMatchAnyHint, matchStorageStepHints, type WaitingWorkspaceStep } from './storage-step-rules'

export * from './storage-step-rules'

/**
 * The name shown in the pop-up ("Adam Mihaly" / the company), or null when this owner is neither a person with a contact nor a company
 * with an account (nothing can be waiting for it). Kept apart from the case lookup below on purpose.
 */
async function ownerDisplayName(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* tables are not in the generated types
  db: any,
  owner: { kind: string; contact_id: string | null; account_id: string | null },
): Promise<string | null> {
  if (owner.kind === 'person' && owner.contact_id) {
    const c = await db.from('contacts').select('full_name').eq('id', owner.contact_id).maybeSingle()
    if (c.error) throw new Error(c.error.message)
    return (c.data?.full_name as string | undefined) ?? 'This person'
  }
  if (owner.kind === 'company' && owner.account_id) {
    const a = await db.from('accounts').select('company_name').eq('id', owner.account_id).maybeSingle()
    if (a.error) throw new Error(a.error.message)
    return (a.data?.company_name as string | undefined) ?? 'This company'
  }
  return null
}

/**
 * The open cases of the owner of this storage (a person's ITIN case, a company's cases) that are waiting for a file of this type going
 * into this folder. A type that no row could ever match (a passport, a tax return) answers [] WITHOUT touching the database.
 * Throws when a record cannot be read — the caller refuses the save ("nothing was saved"), it never lets it through.
 */
export async function findWaitingWorkspaceSteps(input: {
  ownerId: string
  folderId: string | null
  documentType: string | null
  /** Saved through a company's "2. Contacts" folder: the file lands in THIS person's own storage, so their cases are the ones to look at. */
  personContactId?: string | null
}): Promise<WaitingWorkspaceStep[]> {
  if (!typeCouldWait(input.documentType)) return []

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* tables are not in the generated types
  const db = supabaseAdmin as any

  let folderKind: string | null = null
  if (input.folderId) {
    const f = await db.from('store_folders').select('kind').eq('id', input.folderId).maybeSingle()
    if (f.error) throw new Error(f.error.message)
    folderKind = (f.data?.kind as string | null | undefined) ?? null
  }
  if (!couldMatchAnyHint(input.documentType, folderKind)) return []

  const serviceTypes = Array.from(new Set(STORAGE_STEP_HINTS.map((h) => h.serviceType)))
  let q = db.from('service_deliveries').select('id, service_type, stage, status, contact_id, account_id').in('service_type', serviceTypes)
  let owner: { kind: string; contact_id: string | null; account_id: string | null } | null
  // the person override only means something for a "2. Contacts" folder — anywhere else the save ignores it, so the check must too
  if (input.personContactId && folderKind === 'contacts') {
    owner = { kind: 'person', contact_id: input.personContactId, account_id: null }
  } else {
    const o = await db.from('store_owners').select('kind, contact_id, account_id').eq('id', input.ownerId).maybeSingle()
    if (o.error) throw new Error(o.error.message)
    owner = (o.data as { kind: string; contact_id: string | null; account_id: string | null } | null) ?? null
  }
  if (!owner) return []

  const who = await ownerDisplayName(db, owner)
  if (who === null) return []
  if (owner.kind === 'person') q = q.eq('contact_id', owner.contact_id)
  else q = q.eq('account_id', owner.account_id)
  const cases = await q
  if (cases.error) throw new Error(cases.error.message)

  return matchStorageStepHints({
    cases: ((cases.data ?? []) as Array<{ id: string; service_type: string; stage: string; status: string; contact_id?: string | null; account_id?: string | null }>).map((r) => ({
      sdId: r.id,
      serviceType: r.service_type,
      stage: r.stage,
      status: r.status,
      who,
      contactId: r.contact_id ?? null,
      accountId: r.account_id ?? null,
    })),
    documentType: input.documentType,
    folderKind,
  })
}
