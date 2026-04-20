import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'

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

  const body = await req.json().catch(() => null) as { label?: string; apply_url?: string; enabled?: boolean } | null
  if (!body) return NextResponse.json({ error: 'invalid body' }, { status: 400 })

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (typeof body.label === 'string' && body.label.trim()) patch.label = body.label.trim()
  if (typeof body.apply_url === 'string' && body.apply_url.trim()) {
    try {
      const u = new URL(body.apply_url)
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme')
    } catch {
      return NextResponse.json({ error: 'apply_url must be a valid http(s) URL' }, { status: 400 })
    }
    patch.apply_url = body.apply_url.trim()
  }
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled

  const { data, error } = await sb
    .from('bank_referrals')
    .update(patch)
    .eq('slug', params.slug)
    .select()
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
