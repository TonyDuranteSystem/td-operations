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

function slugify(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

export async function GET() {
  const auth = await requireAdmin()
  if (auth) return auth

  const { data, error } = await sb
    .from('bank_referrals')
    .select(BANK_COLUMNS)
    .order('sort_order', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ referrals: data ?? [] })
}

export async function POST(req: Request) {
  const auth = await requireAdmin()
  if (auth) return auth

  const body = await req.json().catch(() => null) as {
    label?: string
    apply_url?: string
    slug?: string
    rep_email?: string | null
    tag?: string | null
    description_en?: string | null
    description_it?: string | null
    managed?: boolean
    sort_order?: number
  } | null
  if (!body?.label || !body?.apply_url) {
    return NextResponse.json({ error: 'label and apply_url required' }, { status: 400 })
  }

  const managed = body.managed === true
  const urlError = validateApplyUrl(body.apply_url, managed)
  if (urlError) return NextResponse.json({ error: urlError }, { status: 400 })

  const slug = body.slug?.trim() || slugify(body.label)
  if (!slug) return NextResponse.json({ error: 'could not derive slug from label' }, { status: 400 })

  const { data, error } = await sb
    .from('bank_referrals')
    .insert({
      slug,
      label: body.label.trim(),
      apply_url: body.apply_url.trim(),
      rep_email: body.rep_email?.trim() || null,
      tag: body.tag?.trim() || null,
      description_en: body.description_en?.trim() || null,
      description_it: body.description_it?.trim() || null,
      managed,
      // New banks land at the end of the list unless a position is given.
      sort_order: Number.isFinite(body.sort_order) ? body.sort_order : 100,
      enabled: true,
    })
    .select(BANK_COLUMNS)
    .single()
  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: `slug "${slug}" already exists` }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ referral: data })
}
