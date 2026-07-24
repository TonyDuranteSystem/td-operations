import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isStaffUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/admin/push — Get VAPID public key
 * POST /api/admin/push — Save an admin push subscription (STAFF ONLY)
 * DELETE /api/admin/push — Remove an admin push subscription
 *
 * ⛔ THE STAFF GATE ON POST IS LOAD-BEARING. This table decides who receives
 * internal notifications: team chat, staff notes on client messages, client
 * chat previews. Until 2026-07-24 the POST required only *a* logged-in user, so
 * a partner's browser or a client's portal login could register itself here and
 * start receiving all of it. Production was clean (two devices, both staff), but
 * the door was open. Antonio: "the client's browser never has to get anything
 * about our business."
 *
 * `isStaffUser`, not `isDashboardUser` — the latter only excludes clients and a
 * managed partner passes it. DELETE stays open to any logged-in user on purpose:
 * removing YOUR OWN device is always allowed, and it is scoped to your user id.
 */
export async function GET() {
  const publicKey = process.env.VAPID_PUBLIC_KEY
  if (!publicKey) return NextResponse.json({ error: 'Push not configured' }, { status: 503 })
  return NextResponse.json({ publicKey })
}

export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isStaffUser(user)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const email = user.email || ''

  const body = await request.json()
  const { subscription } = body

  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return NextResponse.json({ error: 'Invalid subscription' }, { status: 400 })
  }

  // Upsert: delete existing for same endpoint, then insert
  await supabaseAdmin
    .from('admin_push_subscriptions')
    .delete()
    .eq('user_id', user.id)
    .eq('endpoint', subscription.endpoint)

  const { error } = await supabaseAdmin
    .from('admin_push_subscriptions')
    .insert({
      user_id: user.id,
      email,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth_key: subscription.keys.auth,
    })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}

export async function DELETE(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const { endpoint } = body

  if (endpoint) {
    await supabaseAdmin
      .from('admin_push_subscriptions')
      .delete()
      .eq('user_id', user.id)
      .eq('endpoint', endpoint)
  } else {
    await supabaseAdmin
      .from('admin_push_subscriptions')
      .delete()
      .eq('user_id', user.id)
  }

  return NextResponse.json({ success: true })
}
