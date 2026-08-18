/**
 * Research Console — condition -> Supabase query translation.
 *
 * Every condition is validated against the entity registry before it ever
 * touches a query builder call: the field must be a declared field of the
 * entity, and the operator must be valid for that field's type. This is the
 * whitelist that keeps a client from naming an arbitrary column or table —
 * see lib/research/entity-registry.ts for the registry itself.
 *
 * Uses the Supabase JS client's typed filter methods (.eq/.ilike/.in/etc),
 * never raw SQL strings, so there is no injection surface here.
 */

import { getField, type EntityConfig, type FieldConfig, type FieldType } from './entity-registry'

export type Operator =
  | 'contains' | 'equals' | 'starts_with'
  | 'is_any_of'
  | 'before' | 'after' | 'on_or_after' | 'on_or_before' | 'between'
  | 'gt' | 'gte' | 'lt' | 'lte'
  | 'is_true' | 'is_false'
  | 'is_empty' | 'is_not_empty'

export const OPERATORS_BY_TYPE: Record<FieldType, Operator[]> = {
  text: ['contains', 'equals', 'starts_with', 'is_empty', 'is_not_empty'],
  select: ['is_any_of', 'is_empty', 'is_not_empty'],
  date: ['before', 'after', 'on_or_after', 'on_or_before', 'between', 'is_empty', 'is_not_empty'],
  number: ['equals', 'gt', 'gte', 'lt', 'lte', 'between', 'is_empty', 'is_not_empty'],
  boolean: ['is_true', 'is_false'],
  reference: ['is_any_of'],
}

export interface Condition {
  field: string
  operator: Operator
  value?: string | number | null
  value2?: string | number | null
  values?: (string | number)[]
}

export class InvalidConditionError extends Error {}

function validateCondition(entity: EntityConfig, condition: Condition): FieldConfig {
  const field = getField(entity, condition.field)
  if (!field) {
    throw new InvalidConditionError(`Unknown field "${condition.field}" for entity "${entity.key}"`)
  }
  const allowed = OPERATORS_BY_TYPE[field.type]
  if (!allowed.includes(condition.operator)) {
    throw new InvalidConditionError(
      `Operator "${condition.operator}" is not valid for field "${field.key}" (type ${field.type})`
    )
  }
  return field
}

/**
 * Applies a validated list of conditions (ANDed) to a Supabase query builder.
 * `query` is `any` because the Supabase query-builder type changes shape with
 * every chained call — this mirrors the pattern already used throughout
 * app/(dashboard) pages (see accounts/page.tsx).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyConditions(query: any, entity: EntityConfig, conditions: Condition[]): any {
  for (const condition of conditions) {
    const field = validateCondition(entity, condition)
    query = applyOne(query, field, condition)
  }
  return query
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyOne(query: any, field: FieldConfig, condition: Condition): any {
  const col = field.key

  switch (condition.operator) {
    case 'contains':
      return query.ilike(col, `%${condition.value ?? ''}%`)
    case 'starts_with':
      return query.ilike(col, `${condition.value ?? ''}%`)
    case 'equals':
      return query.eq(col, condition.value ?? '')
    case 'is_any_of':
      return query.in(col, condition.values && condition.values.length > 0 ? condition.values : ['__none__'])
    case 'before':
      return query.lt(col, condition.value)
    case 'after':
      return query.gt(col, condition.value)
    case 'on_or_before':
      return query.lte(col, condition.value)
    case 'on_or_after':
      return query.gte(col, condition.value)
    case 'between':
      return query.gte(col, condition.value).lte(col, condition.value2)
    case 'gt':
      return query.gt(col, condition.value)
    case 'gte':
      return query.gte(col, condition.value)
    case 'lt':
      return query.lt(col, condition.value)
    case 'lte':
      return query.lte(col, condition.value)
    case 'is_true':
      return query.eq(col, true)
    case 'is_false':
      return query.eq(col, false)
    case 'is_empty':
      return query.or(`${col}.is.null,${col}.eq.`)
    case 'is_not_empty':
      return query.not(col, 'is', null)
    default:
      throw new InvalidConditionError(`Unhandled operator "${condition.operator}"`)
  }
}
