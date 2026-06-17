/**
 * stage_layout schema — the UI descriptor stored on pipeline_stages.stage_layout
 * (JSONB). Verified against live sandbox rows (2026-06-14):
 *   { "components": [{ "type": "document_upload", "label": "..." }, ...],
 *     "description": "..." }
 *
 * The renderer (components/flows/stage-renderer.tsx) maps each component's
 * `type` to a React component. Unknown/missing layouts degrade gracefully.
 */

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
  'shipping_info',
  'notes',
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
    const rawComp = comp as { autoAdvance?: unknown }
    components.push({
      type: comp.type as StageComponentType,
      label: typeof comp.label === 'string' ? comp.label : undefined,
      url: typeof comp.url === 'string' ? comp.url : undefined,
      actions: Array.isArray(comp.actions)
        ? comp.actions.map(parseStageAction).filter((a): a is StageAction => a !== null)
        : undefined,
      autoAdvance: typeof rawComp.autoAdvance === 'boolean' ? rawComp.autoAdvance : undefined,
    })
  }
  return {
    components,
    description: typeof raw.description === 'string' ? raw.description : undefined,
  }
}
