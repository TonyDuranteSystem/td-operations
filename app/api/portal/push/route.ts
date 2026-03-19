import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/portal/push — Get VAPID public key
 * POST /api/portal/push — Save push subscription
 * DELETE /api/portal/push — Remove push subscription
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

  const body = await request.json()
  const { subscription, account_id } = body

  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return NextResponse.json({ error: 'Invalid subscription' }, { status: 400 })
  }

  // Access control
  const contactId = getClientContactId(user)
  if (contactId && account_id) {
    const accountIds = await getClientAccountIds(contactId)
    if (!accountIds.includes(account_id)) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }
  }

  // Upsert subscription (replace if same endpoint exists)
  await supabaseAdmin
    .from('push_subscriptions')
    .delete()
    .eq('user_id', user.id)
    .eq('endpoint', subscription.endpoint)

  const { error } = await supabaseAdmin
    .from('push_subscriptions')
    .insert({
      user_id: user.id,
      account_id: account_id || null,
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
      .from('push_subscriptions')
      .delete()
      .eq('user_id', user.id)
      .eq('endpoint', endpoint)
  } else {
    // Delete all subscriptions for user
    await supabaseAdmin
      .from('push_subscriptions')
      .delete()
      .eq('user_id', user.id)
  }

  return NextResponse.json({ success: true })
}
