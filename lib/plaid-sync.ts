/**
 * Plaid Transaction Sync
 * Pulls transactions from Plaid and upserts into td_bank_feeds.
 * Uses /transactions/sync endpoint (incremental updates).
 */

import { plaidClient } from '@/lib/plaid'
import { supabaseAdmin } from '@/lib/supabase-admin'
import type { Json } from '@/lib/database.types'

export async function syncPlaidTransactions(accessToken: string, bankName: string) {
  // Get cursor from last sync
  const { data: connection } = await supabaseAdmin
    .from('plaid_connections')
    .select('id, last_synced_at, sync_cursor')
    .eq('access_token', accessToken)
    .single()

  let cursor: string | undefined = connection?.sync_cursor ?? undefined
  let hasMore = true
  let added = 0
  let modified = 0

  while (hasMore) {
    const response = await plaidClient.transactionsSync({
      access_token: accessToken,
      cursor,
      options: { include_personal_finance_category: true },
    })

    const { added: newTxns, modified: modTxns, next_cursor, has_more } = response.data

    // Process added transactions
    for (const txn of newTxns) {
      const isIncoming = txn.amount < 0 // Plaid: negative = money coming IN

      const { error: upsertErr } = await supabaseAdmin.from('td_bank_feeds').upsert({
        source: bankName.toLowerCase().replace(/\s+/g, '_'),
        external_id: txn.transaction_id,
        transaction_date: txn.date,
        amount: Math.abs(txn.amount),
        currency: txn.iso_currency_code ?? 'USD',
        sender_name: txn.merchant_name ?? txn.name,
        sender_reference: txn.payment_meta?.reference_number ?? null,
        memo: txn.name,
        raw_data: txn as unknown as Json,
        status: isIncoming ? 'unmatched' : 'outgoing',
      }, { onConflict: 'external_id' })

      if (upsertErr) {
        console.error(`[plaid-sync] Failed to upsert txn ${txn.transaction_id}:`, upsertErr.message)
        continue
      }

      if (isIncoming) added++
    }

    // Process modified transactions
    for (const txn of modTxns) {
      await supabaseAdmin.from('td_bank_feeds')
        .update({
          memo: txn.name,
          sender_name: txn.merchant_name ?? txn.name,
          raw_data: txn as unknown as Json,
        })
        .eq('external_id', txn.transaction_id)

      modified++
    }

    cursor = next_cursor
    hasMore = has_more
  }

  // Update last_synced_at and persist cursor for incremental sync
  if (connection) {
    await supabaseAdmin
      .from('plaid_connections')
      .update({
        last_synced_at: new Date().toISOString(),
        sync_cursor: cursor,
      })
      .eq('id', connection.id)
  }

  return { added, modified }
}
