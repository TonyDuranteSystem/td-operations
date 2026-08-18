import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isAdmin } from '@/lib/auth'
import { getEntity } from '@/lib/research/entity-registry'
import { InvalidConditionError, applyConditions, type Condition } from '@/lib/research/query-builder'

/** GET /api/research/saved-searches — list all saved searches, newest first. */
export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // research_saved_searches is a new table not yet in the generated Supabase
  // types — cast at the boundary rather than trust codegen (see gen:types
  // worktree gotcha; regenerating requires an authenticated CLI session).
  const { data, error } = await (supabaseAdmin.from('research_saved_searches' as any) as any)
    .select('id, name, entities, conditions, created_by, created_at')
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ items: data ?? [] })
}

interface SaveBody {
  name: string
  entities: string[]
  conditions: Condition[]
}

/** POST /api/research/saved-searches — save the current record types + filter set with a name. */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: SaveBody
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.name?.trim()) {
    return NextResponse.json({ error: 'Name is required' }, { status: 400 })
  }

  const entityKeys = Array.isArray(body.entities) ? body.entities : []
  if (entityKeys.length === 0) {
    return NextResponse.json({ error: 'Select at least one record type' }, { status: 400 })
  }

  const entities = []
  for (const key of entityKeys) {
    const entity = getEntity(key)
    if (!entity) return NextResponse.json({ error: `Unknown entity "${key}"` }, { status: 400 })
    entities.push(entity)
  }

  // Validate the condition list the same way the search route does (each
  // condition must apply to at least one selected entity), so a saved
  // search can never persist a broken/invalid filter.
  for (const c of body.conditions ?? []) {
    const entity = entities.find(e => e.fields.some(f => f.key === c.field))
    if (!entity) {
      return NextResponse.json({ error: `Field "${c.field}" doesn't belong to any selected record type` }, { status: 400 })
    }
    try {
      applyConditions((supabaseAdmin.from(entity.table as any) as any).select('id'), entity, [c])
    } catch (e) {
      if (e instanceof InvalidConditionError) {
        return NextResponse.json({ error: e.message }, { status: 400 })
      }
      throw e
    }
  }

  const { data, error } = await (supabaseAdmin.from('research_saved_searches' as any) as any)
    .insert({
      name: body.name.trim(),
      entities: entityKeys,
      conditions: body.conditions ?? [],
      created_by: user.email ?? user.id,
    })
    .select('id, name, entities, conditions, created_by, created_at')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ item: data })
}
