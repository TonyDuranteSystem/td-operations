import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/admin/push — Get VAPID public key
 * POST /api/admin/push — Save admin push subscription
 * DELETE /api/admin/push — Remove admin push subscription
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

  // Only allow admin emails
  const email = user.email || ''
  if (!email.endsWith('@tonydurante.us') && !email.endsWith('@tonydurante.com')) {
    return NextResponse.json({ error: 'Admin access only' }, { status: 403 })
  }

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
