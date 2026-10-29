/**
 * stage_layout schema — the UI descriptor stored on pipeline_stages.stage_layout
 * (JSONB). Verified against live sandbox rows (2026-06-14):
 *   { "components": [{ "type": "document_upload", "label": "..." }, ...],
 *     "description": "..." }
 *
 * The renderer (components/flows/stage-renderer.tsx) maps each component's
 * `type` to a React component. Unknown/missing layouts degrade gracefully.
 *
 * Author-facing text (`label`, `description`) may reference a system token such
 * as `{td_mailing_address}`, resolved here at parse time so the stored row never
 * carries its own copy of a value that lives in code. See lib/td-address.ts.
 */

import { interpolateString } from '@/lib/template-interpolation'
import { STAGE_LAYOUT_TOKENS } from '@/lib/td-address'

/** Fill system tokens; unknown ones are left literal so the gap is visible. */
function resolveTokens(text: string): string {
  return interpolateString(text, STAGE_LAYOUT_TOKENS)
}

export const STAGE_COMPONENT_TYPES = [
  'info_panel',
  'document_upload',
  'document_viewer',
  'data_viewer',
  'chat',
  'action_buttons',
  'external_link',
  'signature_send',
  'signature_status',
  'waiting_notice',
  'fax_irs',
  'ss4_fax_panel',
  'activate_ra',
  'ss4_panel',
  'ss4_correction_panel',
  'ein_entry',
  'shipping_info',
  'formation_names',
  'members_panel',
  'notes',
  'irs_tracking_entry',
  'suite_panel',
  'closure_wrapup',
  // E-sign (the esign_* engine) of a form for THIS delivery: prepare it, see its status; the delivery
  // moves on by itself when the client has signed (lib/esign/delivery-advance.ts).
  'esign_panel',
  // Company Change Name, "Update our records": the one button that renames the company and moves its old folders (lib/operations/change-name-apply.ts).
  'apply_name_panel',
] as const

export type StageComponentType = (typeof STAGE_COMPONENT_TYPES)[number]

/**
 * An action_buttons entry. Either a bare key resolved by the component's
 * ACTION_CONFIG (e.g. "start_review", "complete"), or an object for the generic
 * "advance_next" forward action which carries its own button label and an
 * explicit target stage to advance to.
 */
export type StageAction = string | { key: string; label?: string; target?: string }

export interface StageComponent {
  type: StageComponentType
  /** document_upload / external_link / waiting_notice label/text */
  label?: string
  /** external_link target */
  url?: string
  /** action_buttons: list of action keys or advance_next objects */
  actions?: StageAction[]
  /** document_upload: whether the upload auto-advances the SD (default true).
   *  Set false when an explicit action (e.g. signature_send) owns the advance. */
  autoAdvance?: boolean
  /** document_upload: target Drive subfolder NAME (e.g. "1. Company"). When set
   *  and the account has a Drive folder, the file is filed into that subfolder
   *  (matched case/space-insensitively); if the subfolder can't be found the
   *  upload falls back to the account root folder (never fails). Absent = root. */
  folder?: string
  /** document_upload: filename template with `{token}` interpolation against
   *  the account (e.g. "EIN Official – {company_name}"). The original file
   *  extension is preserved. If any token is missing the original filename is
   *  kept. Absent = keep the uploaded filename. */
  rename?: string
  /** document_upload: the DEFAULT Storage document type of this box (a catalog slug, e.g. "itin_letter"). When set, the box shows a type picker
   *  (the Storage list for where the file lands, this one pre-selected) and the upload must carry a type — the Storage rule. Absent = no picker,
   *  the upload behaves as before. One line in the layout moves a box over to the model. */
  documentType?: string
  /** document_upload: what the "workspace step is waiting" pop-up and the guide know about this box (see StageBoxStorageHint). */
  storageHint?: StageBoxStorageHint
  /** document_viewer: render with a collapse/expand toggle, starting collapsed.
   *  Absent/false = always-open list (original behavior, unchanged). */
  collapsible?: boolean
}

/** One thing the workspace does when this box takes its file. `key` names an action Storage itself ALSO does for some types (STORAGE_OWN_ACTIONS). */
export interface StageBoxEffect {
  text: string
  key?: string
}

/**
 * document_upload: how the "a workspace step is waiting for this document" pop-up (and the step-by-step guide) learn about this box — dev job
 * e3215801, "make it flexible, not hardcoded" (Antonio 2026-10-28). Everything is optional and lives WITH the stage, so adding a service is data only
 * (lib/flows/storage-step-rules.ts builds the rules from these layouts). Needs the box's `documentType`: a box with no type can never be matched.
 */
export interface StageBoxStorageHint {
  /** Plain words: the document the box asks for ("the IRS approval letter (CP565)"). Absent: the box's own label. */
  asks?: string
  /** Other Storage document types that count as this box's document (besides `documentType`). */
  acceptsTypes?: string[]
  /** The KIND of folder this document lives in (e.g. "itin"). Needed for `typeNeedsFolder` / `otherDocumentCounts`. */
  folderKind?: string
  /** `documentType` is a GENERIC type (e.g. "receipt"): it only counts inside a folder of `folderKind`. */
  typeNeedsFolder?: boolean
  /** A file typed "Other document" (or untyped) in a folder of `folderKind` MAY be this document, so it counts too. */
  otherDocumentCounts?: boolean
  /** The stages of an OPEN case at which a matching file means "this box is waiting". Absent: only the box's own stage. */
  fromStages?: string[]
  /** What uploading in the workspace does (verified sentences only). Absent: the pop-up says only the always-true line. */
  effects?: StageBoxEffect[]
}

function strList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out = v.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
  return out.length > 0 ? out : undefined
}

/** Narrow a raw `storageHint` into the typed shape; anything unusable is dropped (never throws). */
export function parseStorageHint(value: unknown): StageBoxStorageHint | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const effects: StageBoxEffect[] = []
  if (Array.isArray(raw.effects)) {
    for (const e of raw.effects) {
      if (typeof e === 'string' && e.trim()) effects.push({ text: e })
      else if (e && typeof e === 'object' && typeof (e as { text?: unknown }).text === 'string' && (e as { text: string }).text.trim()) {
        const key = (e as { key?: unknown }).key
        effects.push({ text: (e as { text: string }).text, ...(typeof key === 'string' && key ? { key } : {}) })
      }
    }
  }
  const out: StageBoxStorageHint = {
    ...(typeof raw.asks === 'string' && raw.asks.trim() ? { asks: raw.asks } : {}),
    ...(strList(raw.acceptsTypes) ? { acceptsTypes: strList(raw.acceptsTypes) } : {}),
    ...(typeof raw.folderKind === 'string' && raw.folderKind ? { folderKind: raw.folderKind } : {}),
    ...(typeof raw.typeNeedsFolder === 'boolean' ? { typeNeedsFolder: raw.typeNeedsFolder } : {}),
    ...(typeof raw.otherDocumentCounts === 'boolean' ? { otherDocumentCounts: raw.otherDocumentCounts } : {}),
    ...(strList(raw.fromStages) ? { fromStages: strList(raw.fromStages) } : {}),
    ...(effects.length > 0 ? { effects } : {}),
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Narrow one raw action entry into a StageAction, or null if unusable. */
function parseStageAction(a: unknown): StageAction | null {
  if (typeof a === 'string') return a
  if (a && typeof a === 'object') {
    const obj = a as { key?: unknown; label?: unknown; target?: unknown }
    if (typeof obj.key !== 'string') return null
    return {
      key: obj.key,
      ...(typeof obj.label === 'string' ? { label: obj.label } : {}),
      ...(typeof obj.target === 'string' ? { target: obj.target } : {}),
    }
  }
  return null
}

export interface StageLayout {
  components: StageComponent[]
  description?: string
}

/** Narrow an unknown JSONB value into a StageLayout, or null if it isn't one. */
export function parseStageLayout(value: unknown): StageLayout | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as { components?: unknown; description?: unknown }
  if (!Array.isArray(raw.components)) return null
  const components: StageComponent[] = []
  for (const c of raw.components) {
    if (!c || typeof c !== 'object') continue
    const comp = c as { type?: unknown; label?: unknown; url?: unknown; actions?: unknown }
    if (typeof comp.type !== 'string') continue
    if (!(STAGE_COMPONENT_TYPES as readonly string[]).includes(comp.type)) continue
    const rawComp = comp as { autoAdvance?: unknown; folder?: unknown; rename?: unknown; collapsible?: unknown; documentType?: unknown; storageHint?: unknown }
    components.push({
      type: comp.type as StageComponentType,
      label: typeof comp.label === 'string' ? resolveTokens(comp.label) : undefined,
      url: typeof comp.url === 'string' ? comp.url : undefined,
      actions: Array.isArray(comp.actions)
        ? comp.actions.map(parseStageAction).filter((a): a is StageAction => a !== null)
        : undefined,
      autoAdvance: typeof rawComp.autoAdvance === 'boolean' ? rawComp.autoAdvance : undefined,
      folder: typeof rawComp.folder === 'string' ? rawComp.folder : undefined,
      rename: typeof rawComp.rename === 'string' ? rawComp.rename : undefined,
      documentType: typeof rawComp.documentType === 'string' && rawComp.documentType ? rawComp.documentType : undefined,
      storageHint: parseStorageHint(rawComp.storageHint),
      collapsible: typeof rawComp.collapsible === 'boolean' ? rawComp.collapsible : undefined,
    })
  }
  return {
    components,
    description: typeof raw.description === 'string' ? resolveTokens(raw.description) : undefined,
  }
}
