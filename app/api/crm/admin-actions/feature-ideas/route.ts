/**
 * Idea request (staff) — feature ideas written by portal clients (dev job 1a23f5f1).
 *
 * GET ?counts=true                       — unhandled ideas per account/contact (drives the BLUE dot on the
 *                                          "Idea request" tab in Portal Chats).
 * GET ?list=true&account_id|contact_id   — the ideas for one thread, newest first.
 * POST { id, handled }                   — tick / untick an idea handled. Staff-only.
 *
 * Staff-only on every method: an idea is internal, and the list endpoint takes an arbitrary account_id/contact_id.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { bucketIdeaCounts } from '@/lib/portal/feature-ideas'

export const dynamic = 'force-dynamic'

// portal_feature_ideas is new and not in the generated database types yet.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ideas = () => (supabaseAdmin as any).from('portal_feature_ideas')

async function staffUser() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user && isDashboardUser(user) ? user : null
}

export async function GET(req: NextRequest) {
  try {
    if (!(await staffUser())) return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
    const sp = req.nextUrl.searchParams

    if (sp.get('counts') === 'true') {
      const { data, error } = await ideas().select('account_id, contact_id').is('handled_at', null).limit(5000)
      if (error) throw error
      return NextResponse.json(bucketIdeaCounts(data ?? []))
    }

    if (sp.get('list') === 'true') {
      const accountId = sp.get('account_id')
      const contactId = sp.get('contact_id')
      if (!accountId && !contactId) return NextResponse.json({ error: 'account_id or contact_id required' }, { status: 400 })
      let q = ideas().select('id, account_id, contact_id, idea, created_at, handled_at, handled_by').order('created_at', { ascending: false }).limit(200)
      q = accountId ? q.eq('account_id', accountId) : q.eq('contact_id', contactId)
      const { data, error } = await q
      if (error) throw error
      return NextResponse.json({ ideas: data ?? [] })
    }

    return NextResponse.json({ error: 'Unsupported query' }, { status: 400 })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await staffUser()
    if (!user) return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
    const { id, handled } = await req.json().catch(() => ({})) as { id?: unknown; handled?: unknown }
    if (typeof id !== 'string' || typeof handled !== 'boolean') {
      return NextResponse.json({ error: 'id and handled (boolean) required' }, { status: 400 })
    }
    const { error } = await ideas()
      .update(handled ? { handled_at: new Date().toISOString(), handled_by: user.email ?? user.id } : { handled_at: null, handled_by: null })
      .eq('id', id)
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
