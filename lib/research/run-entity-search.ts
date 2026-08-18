import { supabaseAdmin } from '@/lib/supabase-admin'
import type { EntityConfig } from './entity-registry'
import { applyConditions, type Condition } from './query-builder'

const PAGE_SIZE = 50

export interface EntitySearchResult {
  entity: string
  items: Record<string, unknown>[]
  total: number
  truncated: boolean
}

/**
 * Runs one entity's query with only the conditions that entity actually has
 * fields for — a condition on a field another entity doesn't have simply
 * doesn't touch this entity's results, it never errors or excludes the
 * entity outright. Shared by the search route and the Excel-export route so
 * both use the exact same query logic — one engine, never two answers.
 */
export async function runEntitySearch(entity: EntityConfig, conditions: Condition[], page: number): Promise<EntitySearchResult> {
  const applicable = conditions.filter(c => entity.fields.some(f => f.key === c.field))
  const columns = Array.from(new Set(['id', entity.displayField, ...entity.fields.map(f => f.key)]))

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query = (supabaseAdmin.from(entity.table as any) as any)
    .select(columns.join(','), { count: 'exact' })
    .order(entity.defaultSort.field, { ascending: entity.defaultSort.ascending })

  query = applyConditions(query, entity, applicable)

  const from = (page - 1) * PAGE_SIZE
  query = query.range(from, from + PAGE_SIZE - 1)

  const { data, count, error } = await query
  if (error) throw new Error(`${entity.key}: ${error.message}`)

  const total = count ?? 0
  return {
    entity: entity.key,
    items: data ?? [],
    total,
    // PAGE_SIZE caps EACH entity independently in multi-entity mode (no
    // combined cross-table pagination — heterogeneous tables can't share one
    // page cursor). truncated=true must be shown plainly in the UI, never
    // silently dropped, when an entity has more matches than fit on one page.
    truncated: total > (data ?? []).length,
  }
}
