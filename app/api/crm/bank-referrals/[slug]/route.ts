import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { BANK_COLUMNS, validateApplyUrl } from '@/lib/bank-referrals'

// Untyped view of supabaseAdmin — the generated DB types don't include
// bank_referrals yet; remove once regenerated.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = supabaseAdmin as any

async function requireAdmin() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  return null
}

export async function PATCH(
  req: Request,
  { params }: { params: { slug: string } },
) {
  const auth = await requireAdmin()
  if (auth) return auth

  const body = await req.json().catch(() => null) as {
    label?: string
    apply_url?: string
    enabled?: boolean
    rep_email?: string | null
    tag?: string | null
    description_en?: string | null
    description_it?: string | null
    managed?: boolean
    sort_order?: number
  } | null
  if (!body) return NextResponse.json({ error: 'invalid body' }, { status: 400 })

  // The link rule depends on whether the bank is managed, and BOTH can change
  // in the same edit — so validate against the resulting state, not the old
  // one. Read the current row first (also gives us a clean 404).
  const { data: existing } = await sb
    .from('bank_referrals')
    .select('apply_url, managed')
    .eq('slug', params.slug)
    .maybeSingle()
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (typeof body.label === 'string' && body.label.trim()) patch.label = body.label.trim()
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
  if (typeof body.managed === 'boolean') patch.managed = body.managed
  if (Number.isFinite(body.sort_order)) patch.sort_order = body.sort_order
  if ('rep_email' in body) patch.rep_email = body.rep_email?.trim() || null
  if ('tag' in body) patch.tag = body.tag?.trim() || null
  if ('description_en' in body) patch.description_en = body.description_en?.trim() || null
  if ('description_it' in body) patch.description_it = body.description_it?.trim() || null

  const nextManaged = typeof body.managed === 'boolean' ? body.managed : existing.managed === true
  const nextUrl = typeof body.apply_url === 'string' && body.apply_url.trim()
    ? body.apply_url.trim()
    : (existing.apply_url as string)
  const urlError = validateApplyUrl(nextUrl, nextManaged)
  if (urlError) return NextResponse.json({ error: urlError }, { status: 400 })
  if (typeof body.apply_url === 'string' && body.apply_url.trim()) patch.apply_url = nextUrl

  const { data, error } = await sb
    .from('bank_referrals')
    .update(patch)
    .eq('slug', params.slug)
    .select(BANK_COLUMNS)
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ referral: data })
}

export async function DELETE(
  _req: Request,
  { params }: { params: { slug: string } },
) {
  const auth = await requireAdmin()
  if (auth) return auth

  // Only allow hard delete if no click events exist for this slug — otherwise
  // disable (soft-delete) to preserve click history for reporting.
  const { count } = await sb
    .from('bank_referral_clicks')
    .select('id', { count: 'exact', head: true })
    .eq('bank_slug', params.slug)
  if ((count ?? 0) > 0) {
    const { error } = await sb
      .from('bank_referrals')
      .update({ enabled: false, updated_at: new Date().toISOString() })
      .eq('slug', params.slug)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ disabled: true, reason: 'has click history — disabled instead of deleted' })
  }

  const { error } = await sb
    .from('bank_referrals')
    .delete()
    .eq('slug', params.slug)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ deleted: true })
}
