/**
 * Pure helpers for the Company Formation flow Workspace data_viewer.
 *
 * The formation wizard stores its data as a flat JSONB blob (wizard_progress.data)
 * whose name fields vary by submission vintage:
 *   - newer: `llc_name_1` / `llc_name_2` / `llc_name_3` (the 3 candidate names)
 *     plus `chosen_name`,
 *   - older: a single `llc_name` / `company_name` / `business_name`.
 * The data_viewer surfaces the candidate names PROMINENTLY (the staff's first job
 * at "Wizard Submitted" is to check name availability and confirm one), then
 * renders the rest of the submission via the schema-agnostic grouping helper.
 */

export interface FormationNames {
  /** Ordered candidate LLC names (1–3), de-duplicated, empties dropped. */
  choices: string[]
  /** The name the client marked as chosen, if any. */
  chosen: string | null
}

/** Keys consumed by extractFormationNames — excluded from the grouped view so
 *  the names are not rendered twice (prominent card + grouped fields). */
export const FORMATION_NAME_KEYS = [
  'llc_name_1',
  'llc_name_2',
  'llc_name_3',
  'llc_name',
  'company_name',
  'business_name',
  'chosen_name',
] as const

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t === '' ? null : t
}

/** Extract the candidate LLC names + the chosen name from a formation wizard blob. */
export function extractFormationNames(data: Record<string, unknown> | null | undefined): FormationNames {
  if (!data || typeof data !== 'object') return { choices: [], chosen: null }

  const choices: string[] = []
  for (const key of ['llc_name_1', 'llc_name_2', 'llc_name_3']) {
    const v = str(data[key])
    if (v && !choices.includes(v)) choices.push(v)
  }
  // Fall back to a single-name shape only when no numbered candidates exist.
  if (choices.length === 0) {
    for (const key of ['llc_name', 'company_name', 'business_name']) {
      const v = str(data[key])
      if (v) {
        choices.push(v)
        break
      }
    }
  }

  return { choices, chosen: str(data['chosen_name']) }
}
