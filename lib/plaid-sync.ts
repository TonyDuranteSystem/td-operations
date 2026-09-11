/**
 * Plaid Transaction Sync
 * Pulls transactions from Plaid and upserts into td_bank_feeds.
 * Uses /transactions/sync endpoint (incremental updates).
 */

import { toFeedSource } from "@/lib/finance/feed-vocabulary"
import { plaidClient } from '@/lib/plaid'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { TD_ENTITY_ID } from '@/lib/owner-finance'
import { reportSystemError } from '@/lib/system-errors'
import {
  resolvePlaidTransactionAccount,
  findRegistryEntryForAccount,
  partitionAgainstManualBooks,
  fetchOwnerAccountRegistry,
  type PlaidSubAccount,
  type BookTransactionContent,
  type ExistingManualRow,
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

/**
 * Plaid's raw transaction amount -> the books' own signed convention (positive = money in,
 * negative = money out), for EVERY account type, including credit cards. Deliberately the only
 * place this conversion happens, reused by both the registry-resolved path and the coarse
 * passthrough path below, so the two can never silently disagree.
 *
 * A registry row's `sign_convention` field must NEVER be consulted here: it describes a
 * different, unrelated data source (a hand-typed statement export's own quirk, calibrated in
 * lib/owner-statement-import.ts — e.g. Amex writes a charge positive in ITS file). Plaid's own
 * amount is already normalized and needs no correction; re-applying that flag here double-flips
 * an already-correct sign, exactly reproducing the real, previously-manually-repaired bug where
 * $80,457 of Amex spending posted as income (docs/systems/td-books-ledger-plan.md, 2026-08-31).
 */
export function plaidAmountToSignedAmount(rawPlaidAmount: number): number {
  const magnitude = Math.abs(rawPlaidAmount)
  const isIncoming = rawPlaidAmount < 0
  return isIncoming ? magnitude : -magnitude
}

interface OwnerConnectionFacts {
  id: string
  last_synced_at: string | null
  sync_cursor: string | null
  sync_from_date: string | null
  accounts: PlaidSubAccount[]
}

/**
 * The set of manual row ids already consumed by an earlier, separate sync call — read once per
 * call and used to exclude those rows below, so a manual row can never absorb two different
 * real Plaid transactions across the connection's whole lifetime (a cron tick, a webhook push,
 * and a manual button click can all reach this function for the same connection).
 */
async function fetchConsumedManualRowIds(): Promise<Set<string>> {
  const { data, error } = await supabaseAdmin
    .from('plaid_match_consumption' as never)
    .select('manual_transaction_id')
  if (error) throw new Error(`match-consumption read failed: ${error.message}`)
  return new Set((data ?? []).map((r) => (r as unknown as { manual_transaction_id: string }).manual_transaction_id))
}

/**
 * Existing HAND-ENTERED books rows only (transaction_ref not starting 'feed:'), minus any row
 * already consumed by an earlier sync call — comparing a fresh Plaid candidate against the
 * sweep's own prior output here (instead of just against manual rows) would let a real
 * transaction arriving in a later sync cycle be wrongly matched against an earlier cycle's own
 * insert. Paged: an un-ranged select silently caps at 1000 rows with no error, and a duplicate
 * check that stops looking after 1000 rows waves through exactly the duplicates it exists to
 * catch.
 */
async function fetchExistingManualBooksRows(): Promise<ExistingManualRow[]> {
  const consumed = await fetchConsumedManualRowIds()
  const PAGE = 1000
  const out: ExistingManualRow[] = []
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabaseAdmin
      .from('td_books_transactions')
      .select('id, transaction_date, amount, currency, bank_name, transaction_ref')
      .eq('entity_id', TD_ENTITY_ID)
      .order('transaction_date', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + PAGE - 1)
    if (error) throw new Error(`manual-books pre-check failed: ${error.message}`)
    const page = (data ?? []) as unknown as (ExistingManualRow & { transaction_ref: string | null })[]
    for (const row of page) {
      if (!(row.transaction_ref ?? '').startsWith('feed:') && !consumed.has(row.id)) out.push(row)
    }
    if (page.length < PAGE) break
  }
  return out
}

/**
 * Record which manual row each duplicate match consumed, race-safe: two concurrent syncs
 * matching the same manual row will have exactly one insert succeed (the table's own unique
 * constraint on manual_transaction_id). Returns the set of manual row ids that were ACTUALLY
 * consumed by this call — a candidate whose row lost the race was not really a duplicate after
 * all and must be re-classified as new money by the caller, never silently dropped.
 */
async function persistConsumedRows(
  matches: { plaidTransactionId: string; consumedManualRowId: string }[],
): Promise<Set<string>> {
  if (matches.length === 0) return new Set()
  const { data, error } = await supabaseAdmin
    .from('plaid_match_consumption' as never)
    .upsert(
      matches.map((m) => ({
        manual_transaction_id: m.consumedManualRowId,
        plaid_transaction_id: m.plaidTransactionId,
      })) as never,
      { onConflict: 'manual_transaction_id', ignoreDuplicates: true },
    )
    .select('manual_transaction_id')
  if (error) throw new Error(`match-consumption write failed: ${error.message}`)
  return new Set((data ?? []).map((r) => (r as unknown as { manual_transaction_id: string }).manual_transaction_id))
}

interface PendingCandidate extends BookTransactionContent {
  plaidTransactionId: string
  ownerAccountNumber: string
  ownerAccountType: string
}

export async function syncPlaidTransactions(accessToken: string, bankName: string) {
  // `as never`: sync_from_date/accounts aren't in the generated types yet — see
  // app/api/plaid/accounts/route.ts's sibling comment for the same pattern.
  const { data: connectionRaw, error: connectionError } = await supabaseAdmin
    .from('plaid_connections' as never)
    .select('id, last_synced_at, sync_cursor, sync_from_date, accounts')
    .eq('access_token', accessToken)
    .single()
  if (connectionError) throw new Error(`plaid connection lookup failed: ${connectionError.message}`)
  const connection = connectionRaw as unknown as OwnerConnectionFacts | null

  let cursor: string | undefined = connection?.sync_cursor ?? undefined
  let hasMore = true
  let added = 0
  let modified = 0
  let skippedBeforeCutover = 0

  const cutoverDate = connection?.sync_from_date ?? null
  const connectionAccounts = connection?.accounts ?? []

  // Antonio, 2026-09-11: "it's important the system recognize existing transactions and not
  // make a mess... the account number." A small, per-entity table — always read, for every
  // connection, never gated on which page happened to create it: an account with no registry
  // entry (Relay, Revolut, or anything genuinely new) simply falls through to the coarse
  // passthrough path below, exactly as it always has.
  const registry = await fetchOwnerAccountRegistry()

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
  const reportedMissingRegistry = new Set<string>()

  for (const txn of newTxnsAll) {
    if (shouldSkipBeforeCutover(txn.date, cutoverDate)) {
      skippedBeforeCutover++
      continue
    }

    const identity = resolvePlaidTransactionAccount(txn.account_id, connectionAccounts, txn.iso_currency_code ?? 'USD')
    const registryEntry = identity ? findRegistryEntryForAccount(identity, registry) : null

    if (identity && registryEntry) {
      const signedAmount = plaidAmountToSignedAmount(txn.amount)

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

    if (identity && !registryEntry && !reportedMissingRegistry.has(identity.accountNumber)) {
      reportedMissingRegistry.add(identity.accountNumber)
      await reportSystemError({
        source: 'server',
        route: 'lib/plaid-sync.ts:syncPlaidTransactions',
        message: `Plaid resolved a ${identity.accountType} account (${identity.accountNumber}) on "${bankName}" that has no matching entry in the account registry`,
        context: { bankName, accountNumber: identity.accountNumber, accountType: identity.accountType },
      })
    }

    // Genuinely new account (no registry entry), or the sub-account/type couldn't be resolved
    // at all — today's coarse institution-only behavior, unchanged.
    passthroughTxns.push(txn)
  }

  // The expensive full-history scan only runs when there's actually something to check
  // against — an account with no registry match never reaches here, so it never pays this cost.
  const existingManual = pendingCandidates.length > 0 ? await fetchExistingManualBooksRows() : []
  const { toSync: partitionedToSync, skippedAsDuplicate: dupMatches } = pendingCandidates.length > 0
    ? partitionAgainstManualBooks(pendingCandidates, existingManual)
    : { toSync: [] as PendingCandidate[], skippedAsDuplicate: [] as { candidate: PendingCandidate; consumedManualRowId: string }[] }

  // Persist the consumption before trusting it — a race against another sync of the same
  // connection may have already consumed the same manual row. Anything that lost that race was
  // never really a duplicate and must sync as new money, not vanish.
  const actuallyConsumed = await persistConsumedRows(
    dupMatches.map((m) => ({ plaidTransactionId: m.candidate.plaidTransactionId, consumedManualRowId: m.consumedManualRowId })),
  )
  const toSync = [...partitionedToSync]
  for (const m of dupMatches) {
    if (!actuallyConsumed.has(m.consumedManualRowId)) toSync.push(m.candidate)
  }
  const skippedAsDuplicate = dupMatches.filter((m) => actuallyConsumed.has(m.consumedManualRowId)).length

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
