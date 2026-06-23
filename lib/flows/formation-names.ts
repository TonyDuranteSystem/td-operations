/**
 * Pure helpers for the Company Formation flow Workspace data_viewer.
 *
 * At the "Wizard Submitted" stage the client has proposed up to THREE candidate
 * LLC names — there is NO chosen name yet (the choosing happens in this stage,
 * via the SoS availability check + chat with the client). So the viewer shows
 * the three candidates, labeled "Name Choice 1/2/3", and never a "chosen" name.
 *
 * Data shapes vary by submission vintage:
 *   - current: `llc_name_1` / `llc_name_2` / `llc_name_3` (the 3 candidates),
 *   - legacy:  a single `llc_name` / `company_name` / `business_name`.
 * `chosen_name` / `chosen_name_final` may also be present from later steps — they
 * are intentionally NOT surfaced at this stage.
 */

export interface FormationNameChoice {
  /** Display label, e.g. "Name Choice 1" or "Proposed Name". */
  label: string
  /** The candidate name, or null when that slot wasn't filled. */
  value: string | null
}

/** Name-related keys consumed here — excluded from the grouped "rest of data"
 *  view so names aren't rendered twice and no "chosen" name leaks in at this
 *  stage. */
export const FORMATION_NAME_KEYS = [
  'llc_name_1',
  'llc_name_2',
  'llc_name_3',
  'llc_name',
  'company_name',
  'business_name',
  'chosen_name',
  'chosen_name_final',
] as const

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t === '' ? null : t
}

/**
 * Build the candidate-name rows for the "Wizard Submitted" stage.
 *   - When any of `llc_name_1/2/3` is present → exactly 3 rows labeled
 *     "Name Choice 1/2/3" (empty slots carry value=null so the UI can show a
 *     "not provided" placeholder — the 3-choice structure stays explicit).
 *   - Else, a legacy single-name shape → one "Proposed Name" row.
 *   - Else → [].
 * No "chosen" concept — nothing is chosen yet at this stage.
 */
export function formationNameChoices(data: Record<string, unknown> | null | undefined): FormationNameChoice[] {
  if (!data || typeof data !== 'object') return []

  const numbered = [1, 2, 3].map((n) => str(data[`llc_name_${n}`]))
  if (numbered.some((v) => v !== null)) {
    return numbered.map((value, i) => ({ label: `Name Choice ${i + 1}`, value }))
  }

  for (const key of ['llc_name', 'company_name', 'business_name']) {
    const v = str(data[key])
    if (v) return [{ label: 'Proposed Name', value: v }]
  }

  return []
}
