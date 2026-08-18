/**
 * Research Console — draft-condition completeness.
 *
 * Pure logic (no React) so it's directly unit-testable: given a condition
 * being built in the UI, is it actually complete enough to run a search?
 * This is the exact decision the auto-apply UI is built on — see
 * components/research/research-console.tsx.
 */

import type { FieldConfig, FieldType } from './entity-registry'
import { OPERATORS_BY_TYPE, type Operator, type Condition } from './query-builder'

export interface DraftCondition {
  field: string
  operator: Operator
  value: string
  value2: string
  values: string[]
}

export function emptyDraft(field: string, type: FieldType): DraftCondition {
  return { field, operator: OPERATORS_BY_TYPE[type][0], value: '', value2: '', values: [] }
}

/** Returns a real Condition once the draft is complete, or null while it's still being filled in. */
export function draftToCondition(field: FieldConfig, d: DraftCondition): Condition | null {
  switch (d.operator) {
    case 'is_empty':
    case 'is_not_empty':
    case 'is_true':
    case 'is_false':
      return { field: d.field, operator: d.operator }
    case 'is_any_of':
      return d.values.length > 0 ? { field: d.field, operator: d.operator, values: d.values } : null
    case 'between':
      return d.value && d.value2 ? { field: d.field, operator: d.operator, value: d.value, value2: d.value2 } : null
    default:
      return d.value !== '' ? { field: d.field, operator: d.operator, value: field.type === 'number' ? Number(d.value) : d.value } : null
  }
}
