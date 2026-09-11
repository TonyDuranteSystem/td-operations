/**
 * Plaid Transaction Sync
 * Pulls transactions from Plaid and upserts into td_bank_feeds.
 * Uses /transactions/sync endpoint (incremental updates).
 */

import { toFeedSource } from "@/lib/finance/feed-vocabulary"
import { plaidClient } from '@/lib/plaid'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { TD_ENTITY_ID } from '@/lib/owner-finance'
import {
  resolvePlaidTransactionAccount,
  findRegistryEntryForAccount,
  partitionAgainstManualBooks,
  fetchOwnerAccountRegistry,
  type PlaidSubAccount,
  type BookTransactionContent,
} from '@/lib/owner-account-identity'
import type { Json } from '@/lib/database.types'
import type { Transaction as PlaidTransaction } from 'plaid'

/**
 * Pure: should a transaction dated `txnDate` be skipped because it falls on or before this
 * connection's sync_from_date? Both dates are plain 'YYYY-MM-DD' strings (Plaid's own format,
 * and the DATE column's), which compare correctly with a plain string comparison — no Date
 * parsing, no timezone conversion, so no boundary can shift by a day depending on the server's
 * local time. `null` cutover means no prior hand-entered history for this account: sync
 * everything, the safe default for a genuinely new connection.
 *
 * Antonio, 2026-09-11: this is now the SECONDARY, optional safety net, only meaningful if
 * explicitly set at connect time. The primary protection is the automatic account-number-based
 * content match below — "the account number" is the fact every source agrees on; a date a
 * human has to remember is not.
 */
export function shouldSkipBeforeCutover(txnDate: string, cutoverDate: string | null): boolean {
  if (!cutoverDate) return false
  return txnDate <= cutoverDate
}

interface OwnerConnectionFacts {
  id: string
  last_synced_at: string | null
  sync_cursor: string | null
  sync_from_date: string | null
  owner_scoped: boolean
  accounts: PlaidSubAccount[]
}

/**
 * Existing HAND-ENTERED books rows only (transaction_ref not starting 'feed:') — comparing a
 * fresh Plaid candidate against the sweep's own prior output here (instead of just against
 * manual rows) would let a real transaction arriving in a later sync cycle be wrongly matched
 * against an earlier cycle's own insert. Paged: an un-ranged select silently caps at 1000 rows
 * with no error, and a duplicate check that stops looking after 1000 rows waves through exactly
 * the duplicates it exists to catch.
 */
async function fetchExistingManualBooksRows(): Promise<BookTransactionContent[]> {
  const PAGE = 1000
  const out: BookTransactionContent[] = []
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabaseAdmin
      .from('td_books_transactions')
      .select('transaction_date, amount, currency, bank_name, transaction_ref')
      .eq('entity_id', TD_ENTITY_ID)
      .order('transaction_date', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + PAGE - 1)
    if (error) throw new Error(`manual-books pre-check failed: ${error.message}`)
    const page = (data ?? []) as unknown as (BookTransactionContent & { transaction_ref: string | null })[]
    for (const row of page) {
      if (!(row.transaction_ref ?? '').startsWith('feed:')) out.push(row)
    }
    if (page.length < PAGE) break
  }
  return out
}

interface PendingCandidate extends BookTransactionContent {
  plaidTransactionId: string
  ownerAccountNumber: string
  ownerAccountType: string
}

export async function syncPlaidTransactions(accessToken: string, bankName: string) {
  // `as never`: sync_from_date/owner_scoped/accounts aren't in the generated types yet — see
  // app/api/plaid/accounts/route.ts's sibling comment for the same pattern.
  const { data: connectionRaw } = await supabaseAdmin
    .from('plaid_connections' as never)
    .select('id, last_synced_at, sync_cursor, sync_from_date, owner_scoped, accounts')
    .eq('access_token', accessToken)
    .single()
  const connection = connectionRaw as unknown as OwnerConnectionFacts | null

  let cursor: string | undefined = connection?.sync_cursor ?? undefined
  let hasMore = true
  let added = 0
  let modified = 0
  let skippedBeforeCutover = 0
  let skippedAsDuplicate = 0

  const cutoverDate = connection?.sync_from_date ?? null
  const connectionAccounts = connection?.accounts ?? []

  // Antonio, 2026-09-11: "it's important the system recognize existing transactions and not
  // make a mess... the account number." Loaded once, up front, for owner-scoped connections
  // only — Finance's own accounts (Revolut, Relay, Mercury's Plaid entry) have no competing
  // hand-entered data and are completely unaffected by any of this.
  const registry = connection?.owner_scoped ? await fetchOwnerAccountRegistry() : []
  const existingManual = connection?.owner_scoped ? await fetchExistingManualBooksRows() : []

  // Collected across all pages, then reconciled against the manual books ONCE at the end —
  // partitionAgainstManualBooks needs the whole batch together to count multiset duplicates
  // correctly (two genuinely separate same-day, same-amount transactions must both survive).
  const newTxnsAll: PlaidTransaction[] = []
  const modTxnsAll: PlaidTransaction[] = []

  while (hasMore) {
    const response = await plaidClient.transactionsSync({
      access_token: accessToken,
      cursor,
      options: { include_personal_finance_category: true },
    })

    const { added: newTxns, modified: modTxns, next_cursor, has_more } = response.data
    newTxnsAll.push(...newTxns)
    modTxnsAll.push(...modTxns)

    cursor = next_cursor
    hasMore = has_more
  }

  const pendingCandidates: PendingCandidate[] = []
  const passthroughTxns: PlaidTransaction[] = []

  for (const txn of newTxnsAll) {
    if (shouldSkipBeforeCutover(txn.date, cutoverDate)) {
      skippedBeforeCutover++
      continue
    }

    if (connection?.owner_scoped) {
      const identity = resolvePlaidTransactionAccount(txn.account_id, connectionAccounts)
      const registryEntry = identity ? findRegistryEntryForAccount(identity, registry) : null
      if (identity && registryEntry) {
        const magnitude = Math.abs(txn.amount)
        const isIncoming = txn.amount < 0
        let signedAmount = isIncoming ? magnitude : -magnitude
        if (registryEntry.sign_convention === 'inverted') signedAmount = -signedAmount

        pendingCandidates.push({
          plaidTransactionId: txn.transaction_id,
          transaction_date: txn.date,
          amount: Math.round(signedAmount * 100) / 100,
          currency: txn.iso_currency_code ?? 'USD',
          bank_name: registryEntry.bank_name,
          ownerAccountNumber: identity.accountNumber,
          ownerAccountType: identity.accountType,
        })
        continue
      }
    }

    // Not owner-scoped, or the sub-account/type couldn't be resolved — today's coarse
    // institution-only behavior, unchanged.
    passthroughTxns.push(txn)
  }

  const { toSync, skippedAsDuplicate: dupCandidates } = connection?.owner_scoped
    ? partitionAgainstManualBooks(pendingCandidates, existingManual)
    : { toSync: [] as PendingCandidate[], skippedAsDuplicate: [] as PendingCandidate[] }
  skippedAsDuplicate = dupCandidates.length

  const candidateById = new Map(pendingCandidates.map(c => [c.plaidTransactionId, c]))
  const toSyncIds = new Set(toSync.map(c => c.plaidTransactionId))

  // Insert the resolved, deduped, owner-account candidates — carrying the RESOLVED identity
  // and the CANONICAL, registry-matched bank_name/amount, not the coarse institution guess.
  for (const txn of newTxnsAll) {
    const resolved = candidateById.get(txn.transaction_id)
    if (!resolved || !toSyncIds.has(txn.transaction_id)) continue

    const { error: upsertErr } = await supabaseAdmin.from('td_bank_feeds' as never).upsert({
      source: toFeedSource(bankName),
      external_id: txn.transaction_id,
      transaction_date: resolved.transaction_date,
      amount: Math.abs(resolved.amount),
      currency: resolved.currency,
      sender_name: txn.merchant_name ?? txn.name,
      sender_reference: txn.payment_meta?.reference_number ?? null,
      memo: txn.name,
      raw_data: txn as unknown as Json,
      status: resolved.amount > 0 ? 'unmatched' : 'outgoing',
      owner_account_number: resolved.ownerAccountNumber,
      owner_account_type: resolved.ownerAccountType,
    } as never, { onConflict: 'external_id', ignoreDuplicates: true })

    if (upsertErr) {
      console.error(`[plaid-sync] Failed to upsert txn ${txn.transaction_id}:`, upsertErr.message)
      continue
    }
    if (resolved.amount > 0) added++
  }

  // Passthrough path — unchanged from before this feature: institution-only label, no
  // registry lookup, no content check.
  for (const txn of passthroughTxns) {
    const isIncoming = txn.amount < 0

    const { error: upsertErr } = await supabaseAdmin.from('td_bank_feeds').upsert({
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

  // Process modified transactions — unchanged.
  for (const txn of modTxnsAll) {
    await supabaseAdmin.from('td_bank_feeds')
      .update({
        memo: txn.name,
        sender_name: txn.merchant_name ?? txn.name,
        raw_data: txn as unknown as Json,
      })
      .eq('external_id', txn.transaction_id)

    modified++
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

  return { added, modified, skippedBeforeCutover, skippedAsDuplicate }
}
