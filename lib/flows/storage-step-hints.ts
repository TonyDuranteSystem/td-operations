/**
 * "A workspace step is waiting for this document" (dev job e3215801).
 *
 * Real incident (2026-10-23, Adam Mihaly): staff filed his IRS ITIN letter straight into Storage, hidden from the client, instead of
 * uploading it in the ITIN workspace. The workspace step reads the letter, saves the ITIN on the contact, shows the letter to the
 * client, tells the client and closes the case; a plain Storage save does none of that, so the case sat open and the client saw nothing.
 *
 * This module decides, for a file about to be saved in Storage, whether an OPEN case of the same person / company has a workspace step
 * that is waiting for exactly this kind of document. The Storage page then asks staff, in a pop-up, to open the workspace — or to save
 * in Storage only, on purpose. Only the table below says what each step waits for; ITIN first (Antonio), other services are one row each.
 *
 * Pure matching (`matchStorageStepHints`) is separate from the database lookup (`findWaitingWorkspaceSteps`) so the rule is testable.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'

export interface StorageStepHint {
  serviceType: string
  /** The stages of an OPEN case at which a matching file means "the workspace is waiting for this". */
  stages: string[]
  /** Storage document types (catalog slugs) that count. */
  documentTypes: string[]
  /** A file saved into this KIND of folder with one of `vagueTypes` (or with no type) also counts — a file typed "Other document". */
  folderKind?: string
  vagueTypes?: string[]
  /** Plain words: the document the step asks for ("the IRS approval letter (CP565)"). */
  asks: string
  /** What the workspace step does with it that a Storage save does NOT do (shown as "It will NOT: …"). Only things that are verified. */
  workspaceDoes: string[]
}

/**
 * Order matters when two rows could match one case: the first wins. The mailing receipt (its own stage only) comes before the letter,
 * which also covers "Submitted to IRS" because an approval can arrive before the case is moved on.
 * Verified against: app/api/flows/[id]/upload-document/route.ts (isItinApprovalUpload, auto-advance), lib/itin/finalize-approval.ts,
 * and the stage layouts of the ITIN pipeline (Documents Received / Submitted to IRS / ITIN Approved each carry a document_upload).
 */
export const STORAGE_STEP_HINTS: readonly StorageStepHint[] = [
  {
    serviceType: 'ITIN',
    stages: ['Shipped', 'Documents Received'],
    documentTypes: ['itin_application', 'form_w_7'],
    folderKind: 'itin',
    vagueTypes: ['other_document'],
    asks: 'the signed package received from the client',
    workspaceDoes: ['attach it to the case as the received package', 'move the case on to the CAA review'],
  },
  {
    serviceType: 'ITIN',
    stages: ['Submitted to IRS'],
    documentTypes: ['receipt'],
    folderKind: 'itin',
    vagueTypes: ['other_document'],
    asks: 'the mailing receipt for the package sent to the IRS',
    workspaceDoes: ['attach it to the case as the mailing receipt'],
  },
  {
    serviceType: 'ITIN',
    stages: ['Submitted to IRS', 'IRS Processing', 'ITIN Approved'],
    documentTypes: ['itin_letter', 'itin_cp565', 'itin_letter_client_received'],
    folderKind: 'itin',
    vagueTypes: ['other_document'],
    asks: 'the IRS approval letter (CP565)',
    workspaceDoes: [
      'read the ITIN from the letter and save it on the contact',
      'show the letter to the client',
      'tell the client (message, notification and email)',
      'close the case',
    ],
  },
]

/** Statuses of a case that is finished: nothing is waiting any more. */
const FINISHED_STATUSES = ['completed', 'cancelled']

export interface OpenCase {
  sdId: string
  serviceType: string
  stage: string
  status: string
}

export interface WaitingWorkspaceStep {
  sdId: string
  serviceType: string
  stage: string
  /** The person or company the case belongs to ("Adam Mihaly"). */
  who: string
  asks: string
  workspaceDoes: string[]
  /** Where the workspace is. */
  workspacePath: string
}

/** Could ANY hint ever match this type or folder? A cheap test so an ordinary upload never touches the database. */
export function couldMatchAnyHint(documentType: string | null, folderKind: string | null): boolean {
  return STORAGE_STEP_HINTS.some(
    (h) =>
      (documentType !== null && h.documentTypes.indexOf(documentType) !== -1) ||
      (folderKind !== null && h.folderKind === folderKind && (documentType === null || (h.vagueTypes ?? []).indexOf(documentType) !== -1)),
  )
}

function hintFor(c: OpenCase, documentType: string | null, folderKind: string | null): StorageStepHint | null {
  if (FINISHED_STATUSES.indexOf(c.status) !== -1) return null
  for (let i = 0; i < STORAGE_STEP_HINTS.length; i++) {
    const h = STORAGE_STEP_HINTS[i]
    if (h.serviceType !== c.serviceType || h.stages.indexOf(c.stage) === -1) continue
    if (documentType !== null && h.documentTypes.indexOf(documentType) !== -1) return h
    const vague = documentType === null || (h.vagueTypes ?? []).indexOf(documentType) !== -1
    if (vague && h.folderKind && folderKind === h.folderKind) return h
  }
  return null
}

/** Pure: which of these open cases is waiting for a file of this type, going into this kind of folder? */
export function matchStorageStepHints(input: {
  cases: Array<OpenCase & { who: string }>
  documentType: string | null
  folderKind: string | null
}): WaitingWorkspaceStep[] {
  const out: WaitingWorkspaceStep[] = []
  for (let i = 0; i < input.cases.length; i++) {
    const c = input.cases[i]
    const h = hintFor(c, input.documentType, input.folderKind)
    if (!h) continue
    out.push({
      sdId: c.sdId,
      serviceType: c.serviceType,
      stage: c.stage,
      who: c.who,
      asks: h.asks,
      workspaceDoes: h.workspaceDoes,
      workspacePath: `/flows/${c.sdId}`,
    })
  }
  return out
}

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
 * into this folder. Throws when a record cannot be read — the caller refuses the save ("nothing was saved"), it never lets it through.
 */
export async function findWaitingWorkspaceSteps(input: {
  ownerId: string
  folderId: string | null
  documentType: string | null
  /** Saved through a company's "2. Contacts": the file lands in THIS person's own storage, so their cases are the ones to look at. */
  personContactId?: string | null
}): Promise<WaitingWorkspaceStep[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* tables are not in the generated types
  const db = supabaseAdmin as any

  let folderKind: string | null = null
  if (input.folderId) {
    const f = await db.from('store_folders').select('kind').eq('id', input.folderId).maybeSingle()
    if (f.error) throw new Error(f.error.message)
    folderKind = (f.data?.kind as string | null | undefined) ?? null
  }
  // an ordinary upload (no workspace document type, not the ITIN folder) never touches anything else
  if (!couldMatchAnyHint(input.documentType, folderKind)) return []

  const serviceTypes = Array.from(new Set(STORAGE_STEP_HINTS.map((h) => h.serviceType)))
  let q = db.from('service_deliveries').select('id, service_type, stage, status').in('service_type', serviceTypes)
  let owner: { kind: string; contact_id: string | null; account_id: string | null } | null
  if (input.personContactId) {
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
    cases: ((cases.data ?? []) as Array<{ id: string; service_type: string; stage: string; status: string }>).map((r) => ({
      sdId: r.id,
      serviceType: r.service_type,
      stage: r.stage,
      status: r.status,
      who,
    })),
    documentType: input.documentType,
    folderKind,
  })
}
