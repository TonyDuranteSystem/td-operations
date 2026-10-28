/**
 * "A workspace step is waiting for this document" — the RULES (dev job e3215801). Pure: no database, no server imports, so the Storage
 * page can use it in the browser and the server uses the very same code.
 *
 * Real incident (2026-10-23, Adam Mihaly): staff filed his IRS ITIN letter straight into Storage, hidden from the client, instead of
 * uploading it in the ITIN workspace. The workspace step reads the letter, saves the ITIN on the contact, shows the letter to the
 * client, tells the client and closes the case; a plain Storage save does none of that, so the case sat open and the client saw nothing.
 *
 * FLEXIBLE, NOT HARDCODED (Antonio 2026-10-28): there is no list of services in code any more. The rules are BUILT from the workspace's own stage
 * layouts (`pipeline_stages.stage_layout`): every `document_upload` box that carries a `documentType` is a step that waits for that document, and
 * its optional `storageHint` says the rest (the words, other types that count, the folder kind, the stages where the file may arrive, what the
 * workspace does). The "exact next click" is worked out from the layout's own stage buttons (the same path-finder as the step-by-step guide). A new
 * service is covered by typing its upload box — data only, no code. A box without `documentType` is never matched.
 */
import { parseStageLayout, type StageBoxEffect } from '@/lib/flows/stage-layout'
import { pressPath, stageDefsFromRows, type GuideStageDef } from '@/lib/flows/workspace-guide'

export interface StorageStepHint {
  serviceType: string
  /** The stage whose layout holds the box this row comes from, and the box's label. */
  boxStage: string
  boxLabel: string
  /** The stages of an OPEN case at which a matching file means "the workspace is waiting for this". */
  stages: string[]
  /** Storage document types (catalog slugs) that count; the FIRST is the box's own `documentType` (the guide opens on it). */
  documentTypes: string[]
  /** `documentTypes` holds a GENERIC type (e.g. "receipt"): it only counts inside a folder of `folderKind` — a receipt anywhere else is just a receipt. */
  typeNeedsFolder?: boolean
  /** A file saved into this KIND of folder with one of `vagueTypes` (or with no type) also counts — a file typed "Other document". */
  folderKind?: string
  vagueTypes?: string[]
  /** Plain words: the document the step asks for ("the IRS approval letter (CP565)"). */
  asks: string
  /** What to do in the workspace at each stage — the exact buttons and box, worked out from the layout. */
  howByStage: Record<string, string>
  /** What the workspace step does that a Storage save does NOT (shown as "It will NOT: …"). Only sentences written into the box's layout. */
  workspaceDoes: StageBoxEffect[]
}

/**
 * What STORAGE itself does when a file of certain types is saved there — Storage's own behaviour, so it stays in code (it is not a property of
 * any workspace). A box's effect can point at one by `key`: for those types the line moves from "It will NOT" to "Storage will".
 * Verified: a Storage save typed "ITIN Letter" reads the letter itself (lib/crm-store/browse.ts, readIdentityIntoContact); the other letter types do not.
 */
export const STORAGE_OWN_ACTIONS: Readonly<Record<string, { types: readonly string[]; storage: string }>> = {
  read_itin: { types: ['itin_letter'], storage: 'try to read the ITIN number off the letter and save it on the contact' },
}

/** The one line that is true of EVERY workspace upload — used when a box has no verified sentence of its own, so the pop-up never invents specifics. */
export const GENERIC_EFFECT = 'file it on the case and run this step'

/**
 * Build every step rule from the stage rows of ALL services. Rows come from `pipeline_stages` (service_type, stage_name, stage_order, stage_layout).
 * Order matters when two rows could match one case: the first wins — services in the order given, then the stage order inside a service (so the
 * mailing-receipt box of "Submitted to IRS" is tried before the letter box of "ITIN Approved", which also covers "Submitted to IRS").
 */
export function buildStepHints(rows: ReadonlyArray<{ service_type: string; stage_name: string; stage_order: number; stage_layout: unknown }>): StorageStepHint[] {
  const byService = new Map<string, Array<{ stage_name: string; stage_order: number; stage_layout: unknown }>>()
  for (const r of rows) {
    if (!r.service_type || !r.stage_name) continue
    const list = byService.get(r.service_type) ?? []
    list.push(r)
    byService.set(r.service_type, list)
  }
  const out: StorageStepHint[] = []
  for (const [serviceType, serviceRows] of Array.from(byService.entries())) {
    const sorted = [...serviceRows].sort((a, b) => a.stage_order - b.stage_order)
    const defs = stageDefsFromRows(sorted)
    for (const row of sorted) {
      const layout = parseStageLayout(row.stage_layout)
      for (const c of layout?.components ?? []) {
        if (c.type !== 'document_upload' || !c.documentType) continue
        const sh = c.storageHint
        const label = c.label || 'Upload Document'
        const own = row.stage_name
        // the box's own stage is always one of the stages (a hint cannot hide the stage that has the box)
        const stages = Array.from(new Set([...(sh?.fromStages ?? []), own])).filter((s) => defs.some((d) => d.name === s))
        const documentTypes = Array.from(new Set([c.documentType, ...(sh?.acceptsTypes ?? [])]))
        const howByStage: Record<string, string> = {}
        for (const s of stages) howByStage[s] = howToUpload(defs, s, own, label, c.documentType)
        out.push({
          serviceType,
          boxStage: own,
          boxLabel: label,
          stages,
          documentTypes,
          ...(sh?.typeNeedsFolder ? { typeNeedsFolder: true } : {}),
          ...(sh?.folderKind ? { folderKind: sh.folderKind } : {}),
          ...(sh?.otherDocumentCounts ? { vagueTypes: ['other_document'] } : {}),
          asks: sh?.asks ?? `the document for the "${label}" box`,
          howByStage,
          workspaceDoes: sh?.effects && sh.effects.length > 0 ? sh.effects : [{ text: GENERIC_EFFECT }],
        })
      }
    }
  }
  return out
}

/** "Press "A" first, then upload it in the "X" box." — the exact next clicks from the stage the case is at to the box (the guide's own path-finder). */
function howToUpload(defs: readonly GuideStageDef[], at: string, boxStage: string, boxLabel: string, documentType: string): string {
  const box = `the "${boxLabel}" box`
  if (at === boxStage) return `Upload it in ${box}.`
  const found = pressPath(defs, at, new Set([boxStage]))
  const here = defs.find((d) => d.name === at)
  // the stage the case is at may have a DIFFERENT upload box (e.g. the mailing receipt): say so, so the file does not go there
  const other = here?.boxes.find((b) => b.documentType !== documentType)
  const caution = other ? ` Do not use the "${other.label}" box you see now — it is for a different document.` : ''
  if (!found) return `Move the case to "${boxStage}" first, then upload it in ${box}.${caution}`
  const buttons = found.press.map((p) => `"${p.label}"`)
  const lead = buttons.length === 1 ? `Press ${buttons[0]} first` : `Press ${buttons.join(', then ')}`
  return `${lead}, then upload it in ${box}.${caution}`
}

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
  /** "type": the file's document type is the one the step asks for. "folder": it is typed "Other document" (or untyped) in the ITIN folder — it MAY be that document. */
  matchedBy: 'type' | 'folder'
  /** What to do in the workspace at this stage (the buttons and boxes to use). */
  how: string
  /** What a Storage save itself does for this file (so the pop-up never claims otherwise). */
  storageDoes: string[]
  /** What only the workspace step does. */
  workspaceDoes: string[]
  /** Where the workspace is. */
  workspacePath: string
  /** The case's own person / company, so the record of a Storage-only filing shows on THEIR activity too. */
  contactId: string | null
  accountId: string | null
}

/** What the Storage page needs to know to skip the check for an ordinary file — small enough to send to the browser once. */
export interface WaitSummary {
  /** Every Storage type any workspace box takes. */
  types: string[]
  /** Types that count only as "maybe" inside a folder (a file typed "Other document"). */
  vagueTypes: string[]
}

export function waitSummary(hints: readonly StorageStepHint[]): WaitSummary {
  return {
    types: Array.from(new Set(hints.flatMap((h) => h.documentTypes))),
    vagueTypes: Array.from(new Set(hints.flatMap((h) => h.vagueTypes ?? []))),
  }
}

/**
 * Could a file of this type EVER make a rule match? A cheap test so an ordinary upload is not even sent to the check. `summary` null = the
 * list could not be loaded: the answer is yes (check everything) — the check itself fails closed, it never lets a file through unchecked.
 */
export function typeCouldWaitIn(summary: WaitSummary | null, documentType: string | null): boolean {
  if (summary === null) return true
  if (documentType === null) return summary.types.length > 0 || summary.vagueTypes.length > 0
  return summary.types.indexOf(documentType) !== -1 || summary.vagueTypes.indexOf(documentType) !== -1
}

export function typeCouldWait(hints: readonly StorageStepHint[], documentType: string | null): boolean {
  return typeCouldWaitIn(waitSummary(hints), documentType)
}

/** Could ANY rule ever match this type going into this kind of folder? */
export function couldMatchAnyHint(hints: readonly StorageStepHint[], documentType: string | null, folderKind: string | null): boolean {
  return hints.some(
    (h) =>
      (documentType !== null && h.documentTypes.indexOf(documentType) !== -1 && (!h.typeNeedsFolder || (folderKind !== null && h.folderKind === folderKind))) ||
      (folderKind !== null && h.folderKind === folderKind && (documentType === null || (h.vagueTypes ?? []).indexOf(documentType) !== -1)),
  )
}

function hintFor(
  hints: readonly StorageStepHint[],
  c: OpenCase,
  documentType: string | null,
  folderKind: string | null,
): { hint: StorageStepHint; by: 'type' | 'folder' } | null {
  if (FINISHED_STATUSES.indexOf(c.status) !== -1) return null
  for (let i = 0; i < hints.length; i++) {
    const h = hints[i]
    if (h.serviceType !== c.serviceType || h.stages.indexOf(c.stage) === -1) continue
    if (documentType !== null && h.documentTypes.indexOf(documentType) !== -1 && (!h.typeNeedsFolder || (folderKind !== null && h.folderKind === folderKind))) {
      return { hint: h, by: 'type' }
    }
    const vague = documentType === null || (h.vagueTypes ?? []).indexOf(documentType) !== -1
    if (vague && h.folderKind && folderKind === h.folderKind) return { hint: h, by: 'folder' }
  }
  return null
}

/** Pure: which of these open cases is waiting for a file of this type, going into this kind of folder? */
export function matchStorageStepHints(input: {
  hints: readonly StorageStepHint[]
  cases: Array<OpenCase & { who: string; contactId?: string | null; accountId?: string | null }>
  documentType: string | null
  folderKind: string | null
}): WaitingWorkspaceStep[] {
  const out: WaitingWorkspaceStep[] = []
  for (let i = 0; i < input.cases.length; i++) {
    const c = input.cases[i]
    const m = hintFor(input.hints, c, input.documentType, input.folderKind)
    if (!m) continue
    // an effect Storage ALSO does for this very type moves from "It will NOT" to "Storage will"
    const storageOwn = (e: StageBoxEffect) => {
      const a = e.key ? STORAGE_OWN_ACTIONS[e.key] : undefined
      return a && input.documentType !== null && a.types.indexOf(input.documentType) !== -1 ? a : null
    }
    const storageDoes = m.hint.workspaceDoes.map(storageOwn).filter((a): a is NonNullable<typeof a> => a !== null).map((a) => a.storage)
    out.push({
      sdId: c.sdId,
      serviceType: c.serviceType,
      stage: c.stage,
      who: c.who,
      asks: m.hint.asks,
      matchedBy: m.by,
      how: m.hint.howByStage[c.stage] ?? '',
      storageDoes,
      workspaceDoes: m.hint.workspaceDoes.filter((e) => storageOwn(e) === null).map((e) => e.text),
      // "Open the workspace" opens the case with the step-by-step guide on (lib/flows/workspace-guide.ts): the guide is about the document this
      // row's workspace box takes — the row's first type (the box's own `documentType`).
      workspacePath: `/flows/${c.sdId}?guide=${m.hint.documentTypes[0]}`,
      contactId: c.contactId ?? null,
      accountId: c.accountId ?? null,
    })
  }
  return out
}
