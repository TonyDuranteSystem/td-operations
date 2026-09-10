/**
 * Plaid Transaction Sync
 * Pulls transactions from Plaid and upserts into td_bank_feeds.
 * Uses /transactions/sync endpoint (incremental updates).
 */

import { toFeedSource } from "@/lib/finance/feed-vocabulary"
import { plaidClient } from '@/lib/plaid'
import { supabaseAdmin } from '@/lib/supabase-admin'
import type { Json } from '@/lib/database.types'

/**
 * Pure: should a transaction dated `txnDate` be skipped because it falls on or before this
 * connection's sync_from_date? Both dates are plain 'YYYY-MM-DD' strings (Plaid's own format,
 * and the DATE column's), which compare correctly with a plain string comparison — no Date
 * parsing, no timezone conversion, so no boundary can shift by a day depending on the server's
 * local time. `null` cutover means no prior hand-entered history for this account: sync
 * everything, the safe default for a genuinely new connection.
 */
export function shouldSkipBeforeCutover(txnDate: string, cutoverDate: string | null): boolean {
  if (!cutoverDate) return false
  return txnDate <= cutoverDate
}

export async function syncPlaidTransactions(accessToken: string, bankName: string) {
  // `as never`: sync_from_date isn't in the generated types yet — see
  // app/api/plaid/accounts/route.ts's sibling comment for the same pattern.
  // Get cursor from last sync
  const { data: connection } = await supabaseAdmin
    .from('plaid_connections' as never)
    .select('id, last_synced_at, sync_cursor, sync_from_date')
    .eq('access_token', accessToken)
    .single() as unknown as { data: { id: string; last_synced_at: string | null; sync_cursor: string | null; sync_from_date: string | null } | null }

  let cursor: string | undefined = connection?.sync_cursor ?? undefined
  let hasMore = true
  let added = 0
  let modified = 0
  let skippedBeforeCutover = 0

  // Antonio, 2026-09-10: "it's important the system recognize existing transactions and not
  // make a mess." Rather than guess whether an incoming transaction matches something already
  // entered by hand (tried, and found unreliable — see the sync_from_date migration's own
  // comment), a bank connected with prior history simply never pulls in anything from before
  // the date it was told to start at. Nothing to match, nothing to guess wrong.
  const cutoverDate = connection?.sync_from_date ?? null

  while (hasMore) {
    const response = await plaidClient.transactionsSync({
      access_token: accessToken,
      cursor,
      options: { include_personal_finance_category: true },
    })

    const { added: newTxns, modified: modTxns, next_cursor, has_more } = response.data

    // Process added transactions
    for (const txn of newTxns) {
      if (shouldSkipBeforeCutover(txn.date, cutoverDate)) {
        skippedBeforeCutover++
        continue
      }

      const isIncoming = txn.amount < 0 // Plaid: negative = money coming IN

      const { error: upsertErr } = await supabaseAdmin.from('td_bank_feeds').upsert({
        // Mapped, never derived: an unrecognised bank name would be rejected by the
        // database CHECK, silently killing every transaction from that bank.
        source: toFeedSource(bankName),
        external_id: txn.transaction_id,
        transaction_date: txn.date,
        amount: Math.abs(txn.amount),
        currency: txn.iso_currency_code ?? 'USD',
        sender_name: txn.merchant_name ?? txn.name,
        sender_reference: txn.payment_meta?.reference_number ?? null,
        memo: txn.name,
        raw_data: txn as unknown as Json,
        status: isIncoming ? 'unmatched' : 'outgoing',
      }, { onConflict: 'external_id', ignoreDuplicates: true })

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

  return { added, modified, skippedBeforeCutover }
}
