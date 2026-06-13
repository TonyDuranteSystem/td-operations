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
  'notes',
] as const

export type StageComponentType = (typeof STAGE_COMPONENT_TYPES)[number]

export interface StageComponent {
  type: StageComponentType
  /** document_upload / external_link label */
  label?: string
  /** external_link target */
  url?: string
  /** action_buttons: list of action keys (e.g. ["start_review"]) */
  actions?: string[]
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
    components.push({
      type: comp.type as StageComponentType,
      label: typeof comp.label === 'string' ? comp.label : undefined,
      url: typeof comp.url === 'string' ? comp.url : undefined,
      actions: Array.isArray(comp.actions) ? comp.actions.filter((a): a is string => typeof a === 'string') : undefined,
    })
  }
  return {
    components,
    description: typeof raw.description === 'string' ? raw.description : undefined,
  }
}
