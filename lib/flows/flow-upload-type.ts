/**
 * The document type of a WORKSPACE upload must follow the STORAGE rule (dev job e3215801, Antonio 2026-10-28: "when we upload the document in the
 * workspace that will be saved in the storage must follow the storage rule"). Storage's rule: a client's storage always takes a type from the
 * catalog list, the type has to belong to that kind of place (a person's papers vs a company's), and a staff-only type is never shown to the client.
 *
 * A workspace box that carries a type picker sends the chosen slug; this resolves it. A box WITHOUT a picker sends nothing -> `slug: null` and the
 * upload behaves exactly as before (no change for the workspaces that have not been moved over yet). Fails CLOSED: a catalog that cannot be read
 * refuses the upload ("nothing was uploaded") — it never lets an unchecked type through.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'
import { typesForTarget } from '@/lib/crm-store/types-for-target'

export type FlowUploadTypeResult = { ok: true; slug: string | null } | { ok: false; error: string }

export async function resolveFlowUploadType(input: {
  /** The slug the box sent (anything else is refused). */
  slug: unknown
  /** The storage the file lands in: a person's (an ITIN, a flow with no company yet) or a company's. */
  ownerKind: 'person' | 'company'
  /** The file is shown to the client from the start (the ITIN letter). */
  visibleToClient: boolean
  folderKind?: string | null
}): Promise<FlowUploadTypeResult> {
  if (input.slug === undefined || input.slug === null || input.slug === '') return { ok: true, slug: null }
  if (typeof input.slug !== 'string') return { ok: false, error: 'Choose a document type from the list.' }
  const slug = input.slug
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- catalog_entries metadata is free-form JSON
  const { data, error } = await (supabaseAdmin as any)
    .from('catalog_entries')
    .select('slug, metadata')
    .eq('catalog_id', 'storage_document_types')
    .eq('slug', slug)
    .eq('status', 'active')
    .maybeSingle()
  if (error) return { ok: false, error: 'Could not check the document type — nothing was uploaded. Please try again.' }
  if (!data) return { ok: false, error: 'Choose a document type from the list.' }
  const meta = (data.metadata ?? {}) as { personal?: boolean; staff_only?: boolean }
  const option = { slug, personal: meta.personal === true, staffOnly: meta.staff_only === true }
  if (typesForTarget([option], { ownerKind: input.ownerKind, folderKind: input.folderKind }).length === 0) {
    return { ok: false, error: 'This document type does not belong in this storage — choose another type from the list.' }
  }
  if (option.staffOnly && input.visibleToClient) {
    return { ok: false, error: 'This document type is for staff only — the client cannot be shown it. Choose another type.' }
  }
  return { ok: true, slug }
}
