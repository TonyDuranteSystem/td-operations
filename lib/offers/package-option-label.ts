import { FORMATION_STATE_NAMES, type FormationStateCode } from '@/lib/formation/states'

const ENTITY_TYPE_LABELS: Record<'SMLLC' | 'MMLLC' | 'Corp', string> = {
  SMLLC: 'Single-Member LLC',
  MMLLC: 'Multi-Member LLC',
  Corp: 'C-Corp',
}

/**
 * The client-facing label for a multi-option offer's extra package — auto-derived from the
 * company type and state the staffer already picked for it, so nobody types "Single Member
 * Wyoming" by hand (Antonio, 2026-08-27: "we check the option automatically, and it will fill
 * out, but not the price — we will always put the price"). Price stays manual on purpose; this
 * is the ONLY field that isn't.
 *
 * Same "State — Entity Type" order the dialog's own placeholder text already used
 * ("Florida — Multi-Member LLC"), so this doesn't introduce a second convention.
 */
export function formatOptionLabel(
  entityType: 'SMLLC' | 'MMLLC' | 'Corp' | '' | undefined,
  formationState: FormationStateCode | '' | undefined,
): string {
  const stateName = formationState ? FORMATION_STATE_NAMES[formationState] : ''
  const entityLabel = entityType ? ENTITY_TYPE_LABELS[entityType] : ''
  if (stateName && entityLabel) return `${stateName} — ${entityLabel}`
  return stateName || entityLabel || ''
}
