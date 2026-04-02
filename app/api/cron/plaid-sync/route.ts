/**
 * Cron: Plaid Transaction Sync
 * Schedule: every 6 hours via Vercel cron
 *
 * Fallback sync when Plaid webhooks are missed.
 * Queries all active plaid_connections and calls syncPlaidTransactions() for each.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { syncPlaidTransactions } from '@/lib/plaid-sync'

export async function GET(req: NextRequest) {
  try {
    // Verify cron secret (Vercel sends this header)
    const authHeader = req.headers.get('authorization')
    const cronSecret = process.env.CRON_SECRET
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Check if Plaid is configured
    if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
      console.warn('[plaid-sync] Plaid credentials not configured — skipping sync')
      await supabaseAdmin.from('cron_log').insert({
        endpoint: '/api/cron/plaid-sync',
        status: 'skipped',
        details: { reason: 'Plaid credentials not configured' },
        executed_at: new Date().toISOString(),
      })
      return NextResponse.json({ ok: true, skipped: true, reason: 'Plaid not configured' })
    }

    // Get all active Plaid connections
    const { data: connections, error: connErr } = await supabaseAdmin
      .from('plaid_connections')
      .select('id, access_token, bank_name, item_id')
      .eq('status', 'active')

    if (connErr) {
      console.error('[plaid-sync] Failed to query plaid_connections:', connErr.message)
      await supabaseAdmin.from('cron_log').insert({
        endpoint: '/api/cron/plaid-sync',
        status: 'error',
        error_message: connErr.message,
        executed_at: new Date().toISOString(),
      })
      return NextResponse.json({ error: connErr.message }, { status: 500 })
    }

    if (!connections || connections.length === 0) {
      await supabaseAdmin.from('cron_log').insert({
        endpoint: '/api/cron/plaid-sync',
        status: 'success',
        details: { connections: 0, message: 'No active connections' },
        executed_at: new Date().toISOString(),
      })
      return NextResponse.json({ ok: true, connections: 0, synced: 0 })
    }

    // Sync each connection
    let totalAdded = 0
    let totalModified = 0
    let errorCount = 0
    const results: Array<{ bank: string; added: number; modified: number; error?: string }> = []

    for (const conn of connections) {
      try {
        const result = await syncPlaidTransactions(conn.access_token, conn.bank_name)
        totalAdded += result.added
        totalModified += result.modified
        results.push({ bank: conn.bank_name, added: result.added, modified: result.modified })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[plaid-sync] Error syncing ${conn.bank_name}:`, msg)
        errorCount++
        results.push({ bank: conn.bank_name, added: 0, modified: 0, error: msg })
      }
    }

    // Results logged via cron_log table below

    await supabaseAdmin.from('cron_log').insert({
      endpoint: '/api/cron/plaid-sync',
      status: errorCount > 0 ? 'partial' : 'success',
      details: {
        connections: connections.length,
        total_added: totalAdded,
        total_modified: totalModified,
        errors: errorCount,
        results,
      },
      executed_at: new Date().toISOString(),
    })

    return NextResponse.json({
      ok: true,
      connections: connections.length,
      total_added: totalAdded,
      total_modified: totalModified,
      errors: errorCount,
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[plaid-sync] Error:', msg)
    await supabaseAdmin.from('cron_log').insert({
      endpoint: '/api/cron/plaid-sync',
      status: 'error',
      error_message: msg,
      executed_at: new Date().toISOString(),
    }).then(() => null)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
