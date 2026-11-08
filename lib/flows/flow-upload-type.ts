/**
 * The document type of a WORKSPACE upload must follow the STORAGE rule (dev job e3215801, Antonio 2026-10-28: "when we upload the document in the
 * workspace that will be saved in the storage must follow the storage rule"). Storage's rule: a client's storage always takes a type from the
 * catalog list, the type has to belong to that kind of place (a person's papers vs a company's), and a staff-only type is never shown to the client.
 *
 * A workspace box that carries a type picker sends the chosen slug; this resolves it. A box WITHOUT a picker (no `documentType` in its stage
 * layout) sends nothing -> `slug: null` and the upload behaves exactly as before (no change for the workspaces that have not been moved over
 * yet). A box that HAS a default type but sent none (a browser tab opened before the picker existed, or a direct call) gets that default
 * (`fallbackSlug`) — checked like any chosen type — so a typed box can never save a file as the generic "Other document". Fails CLOSED: a
 * catalog that cannot be read refuses the upload ("nothing was uploaded") — it never lets an unchecked type through.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'
import { typesForTarget } from '@/lib/crm-store/types-for-target'
import { parseStageLayout } from '@/lib/flows/stage-layout'

export type FlowUploadTypeResult = { ok: true; slug: string | null } | { ok: false; error: string }

export async function resolveFlowUploadType(input: {
  /** The slug the box sent (anything else is refused). */
  slug: unknown
  /** The storage the file lands in: a person's (an ITIN, a flow with no company yet) or a company's. */
  ownerKind: 'person' | 'company'
  /** The file is shown to the client from the start (the ITIN letter). */
  visibleToClient: boolean
  folderKind?: string | null
  /** The box's default type (from its stage layout), used only when the request sent no type at all. */
  fallbackSlug?: string | null
}): Promise<FlowUploadTypeResult> {
  const sentNothing = input.slug === undefined || input.slug === null || input.slug === ''
  if (sentNothing && !input.fallbackSlug) return { ok: true, slug: null }
  if (!sentNothing && typeof input.slug !== 'string') return { ok: false, error: 'Choose a document type from the list.' }
  const slug = (sentNothing ? input.fallbackSlug : input.slug) as string
  const notUsable = sentNothing
    ? 'This upload needs a document type — please reload the page and choose one from the list.'
    : 'Choose a document type from the list.'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- catalog_entries metadata is free-form JSON
  const { data, error } = await (supabaseAdmin as any)
    .from('catalog_entries')
    .select('slug, metadata')
    .eq('catalog_id', 'storage_document_types')
    .eq('slug', slug)
    .eq('status', 'active')
    .maybeSingle()
  if (error) return { ok: false, error: 'Could not check the document type — nothing was uploaded. Please try again.' }
  if (!data) return { ok: false, error: notUsable }
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

/**
 * The default document type a workspace stage's upload box carries (`documentType` in its stage layout), or null when the stage has no typed
 * box (the legacy, untyped upload). Only when EVERY upload box of the stage is typed with the SAME type — an ambiguous stage stays untyped
 * rather than guessing. A layout that cannot be read is null too (the request's own type, if any, is still checked).
 */
export async function boxDefaultType(serviceType: string | null, stageName: string | null): Promise<string | null> {
  if (!serviceType || !stageName) return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pipeline_stages rows are read loosely here (only stage_layout is needed)
  const { data, error } = await (supabaseAdmin as any)
    .from('pipeline_stages')
    .select('stage_layout')
    .eq('service_type', serviceType)
    .eq('stage_name', stageName)
    .limit(1)
  if (error || !data?.[0]) return null
  return boxTypeOfLayout(data[0].stage_layout)
}

/** The one document type every upload box of a stage layout carries, or null (no typed box, or boxes of different types). */
export function boxTypeOfLayout(stageLayout: unknown): string | null {
  const layout = parseStageLayout(stageLayout)
  const boxes = (layout?.components ?? []).filter((c) => c.type === 'document_upload')
  if (boxes.length === 0) return null
  const types = Array.from(new Set(boxes.map((b) => (typeof b.documentType === 'string' && b.documentType ? b.documentType : ''))))
  return types.length === 1 && types[0] ? types[0] : null
}

/** The generic type that stays free-for-all: a locked step whose box is typed "other document" accepts any type (Company Change Name). */
const GENERIC_BOX_TYPE = 'other_document'

/**
 * Pure rule (production end-to-end test 2026-11-07, dev job eaa4747e): on a step that LOCKS the job until a document is uploaded, a file counts
 * only if it is of the type the step's box asks for. The type picker lets staff choose "Other document", and an unrelated PDF uploaded that way
 * opened the lock of "State Dissolution Filing" — the lock only looks at the step stamp. Returns the refusal sentence, or null = accepted.
 * Not locked, an untyped box, or a box typed "other document" = no rule (unchanged behaviour).
 */
export function lockedBoxTypeProblem(p: { locked: boolean; boxType: string | null; chosenSlug: string | null; boxTypeName?: string | null }): string | null {
  if (!p.locked || !p.boxType || p.boxType === GENERIC_BOX_TYPE) return null
  if (p.chosenSlug === p.boxType) return null
  const name = (p.boxTypeName ?? '').trim() || p.boxType.replace(/_/g, ' ')
  return `This step stays locked until the ${name} is uploaded, so only that kind of file is accepted here: choose "${name}" in the Document type list. (A file of another type would open the lock by mistake.)`
}

/**
 * The refusal for an upload to a locked step whose file is of the wrong type, or null = fine. A read that fails is a refusal too (fails CLOSED,
 * like the type check above): nothing is uploaded and staff try again.
 */
export async function lockedStepUploadProblem(input: { serviceType: string | null; stageName: string | null; chosenSlug: string | null }): Promise<string | null> {
  if (!input.serviceType || !input.stageName) return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pipeline_stages rows are read loosely here
  const { data, error } = await (supabaseAdmin as any)
    .from('pipeline_stages')
    .select('stage_layout, requires_document_to_advance')
    .eq('service_type', input.serviceType)
    .eq('stage_name', input.stageName)
    .limit(1)
  if (error) return 'Could not check what this step needs — nothing was uploaded. Please try again.'
  const row = data?.[0] as { stage_layout: unknown; requires_document_to_advance: boolean | null } | undefined
  if (!row || row.requires_document_to_advance !== true) return null
  const boxType = boxTypeOfLayout(row.stage_layout)
  if (!boxType || boxType === GENERIC_BOX_TYPE || input.chosenSlug === boxType) return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- catalog_entries metadata is free-form JSON
  const { data: entry } = await (supabaseAdmin as any)
    .from('catalog_entries')
    .select('display_name')
    .eq('catalog_id', 'storage_document_types')
    .eq('slug', boxType)
    .maybeSingle()
  return lockedBoxTypeProblem({ locked: true, boxType, chosenSlug: input.chosenSlug, boxTypeName: (entry as { display_name?: string } | null)?.display_name ?? null })
}
