import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isAdmin } from '@/lib/auth'
import { getEntity, getField, getEntity as getRefEntity } from '@/lib/research/entity-registry'

const MAX_SELECT_VALUES = 300
const MAX_REFERENCE_RESULTS = 20

/**
 * GET /api/research/field-values?entities=accounts,contacts&field=status
 * GET /api/research/field-values?entities=deals&field=account_id&q=acme
 *
 * Returns real values pulled live from the database for a 'select' field —
 * unioned across every selected entity that actually has that field, so a
 * shared field like "status" shows every value seen on ANY of the selected
 * record types, not just the first one — or a name-matched picker list for
 * a 'reference' field. Admin-only, same gate as the search route.
 */
export async function GET(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const entityKeys = (request.nextUrl.searchParams.get('entities') ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const fieldKey = request.nextUrl.searchParams.get('field') ?? ''
  const q = request.nextUrl.searchParams.get('q') ?? ''

  if (entityKeys.length === 0) {
    return NextResponse.json({ error: 'entities is required' }, { status: 400 })
  }

  const matchingEntities = []
  for (const key of entityKeys) {
    const entity = getEntity(key)
    if (!entity) return NextResponse.json({ error: `Unknown entity "${key}"` }, { status: 400 })
    const field = getField(entity, fieldKey)
    if (field) matchingEntities.push({ entity, field })
  }
  if (matchingEntities.length === 0) {
    return NextResponse.json({ error: `Field "${fieldKey}" doesn't belong to any selected record type` }, { status: 400 })
  }

  const { field } = matchingEntities[0]

  if (field.type === 'reference' && field.refEntity) {
    const refEntity = getRefEntity(field.refEntity)
    if (!refEntity) {
      return NextResponse.json({ error: `Unknown reference entity "${field.refEntity}"` }, { status: 400 })
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let refQuery = (supabaseAdmin.from(refEntity.table as any) as any)
      .select(`id, ${refEntity.displayField}`)
      .order(refEntity.displayField, { ascending: true })
      .limit(MAX_REFERENCE_RESULTS)
    if (q.trim()) {
      refQuery = refQuery.ilike(refEntity.displayField, `%${q.trim()}%`)
    }
    const { data, error } = await refQuery
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    const options = (data ?? []).map((row: Record<string, unknown>) => ({
      value: row.id,
      label: String(row[refEntity.displayField] ?? row.id),
    }))
    return NextResponse.json({ options })
  }

  if (field.type !== 'select') {
    return NextResponse.json({ error: `Field "${fieldKey}" has no value list (type ${field.type})` }, { status: 400 })
  }

  // Live distinct values, unioned across every entity that has this field —
  // never a hardcoded/guessed list. Capped and deduped in JS since PostgREST
  // has no native DISTINCT support here.
  const seen = new Set<string>()
  for (const { entity } of matchingEntities) {
    const { data, error } = await (supabaseAdmin.from(entity.table as any) as any)
      .select(fieldKey)
      .not(fieldKey, 'is', null)
      .limit(5000)
    if (error) return NextResponse.json({ error: `${entity.key}: ${error.message}` }, { status: 500 })
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const v = row[fieldKey]
      if (v === null || v === undefined) continue
      const s = String(v).trim()
      if (s) seen.add(s)
    }
  }
  const options = Array.from(seen).sort((a, b) => a.localeCompare(b)).slice(0, MAX_SELECT_VALUES)

  return NextResponse.json({ options: options.map(v => ({ value: v, label: v })) })
}
