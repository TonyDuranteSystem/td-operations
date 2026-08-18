import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isAdmin } from '@/lib/auth'
import { getEntity, type EntityConfig } from '@/lib/research/entity-registry'
import { InvalidConditionError, type Condition } from '@/lib/research/query-builder'
import { runEntitySearch } from '@/lib/research/run-entity-search'

interface SearchBody {
  entities: string[]
  conditions?: Condition[]
  page?: number
}

/**
 * POST /api/research/search
 * Generic filter-builder search across the Research Console's entity
 * registry, over one or more record types at once. Admin-only (Antonio +
 * Luca) — this page reads across the entire client base in one call, so it
 * is gated the same way every other whole-client-base surface in the CRM is.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: SearchBody
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const entityKeys = Array.isArray(body.entities) ? body.entities : []
  if (entityKeys.length === 0) {
    return NextResponse.json({ error: 'Select at least one record type' }, { status: 400 })
  }

  const entities: EntityConfig[] = []
  for (const key of entityKeys) {
    const entity = getEntity(key)
    if (!entity) return NextResponse.json({ error: `Unknown entity "${key}"` }, { status: 400 })
    entities.push(entity)
  }

  // Validate every condition against AT LEAST ONE selected entity up front —
  // a field that matches no selected entity at all is almost certainly a
  // client bug (a stale condition left over from before the entity list
  // changed), not something to silently ignore everywhere.
  const conditions = body.conditions ?? []
  for (const c of conditions) {
    const appliesSomewhere = entities.some(e => e.fields.some(f => f.key === c.field))
    if (!appliesSomewhere) {
      return NextResponse.json({ error: `Field "${c.field}" doesn't belong to any selected record type` }, { status: 400 })
    }
  }

  const page = Math.max(1, body.page ?? 1)

  try {
    const results = await Promise.all(
      entities.map(entity => runEntitySearch(entity, conditions, page))
    )
    return NextResponse.json({ results })
  } catch (e) {
    if (e instanceof InvalidConditionError) {
      return NextResponse.json({ error: e.message }, { status: 400 })
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Search failed' }, { status: 500 })
  }
}
