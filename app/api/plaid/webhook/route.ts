/**
 * POST /api/plaid/webhook
 * Receives Plaid webhook events and triggers transaction sync.
 *
 * Register this URL in Plaid Dashboard: <your-domain>/api/plaid/webhook
 */

import { NextRequest, NextResponse } from 'next/server'
import { syncPlaidTransactions } from '@/lib/plaid-sync'
import { supabaseAdmin } from '@/lib/supabase-admin'

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { webhook_type, webhook_code, item_id } = body

  // Log webhook for debugging
  await supabaseAdmin.from('webhook_events').insert({
    source: 'plaid',
    event_type: `${webhook_type}.${webhook_code}`,
    payload: body,
  }).then(() => null)

  if (webhook_type === 'TRANSACTIONS') {
    if (webhook_code === 'SYNC_UPDATES_AVAILABLE' || webhook_code === 'DEFAULT_UPDATE') {
      // Get access token for this item
      const { data: connection } = await supabaseAdmin
        .from('plaid_connections')
        .select('access_token, bank_name')
        .eq('item_id', item_id)
        .single()

      if (connection) {
        await syncPlaidTransactions(connection.access_token, connection.bank_name)
      }
    }
  }

  return NextResponse.json({ received: true })
}
