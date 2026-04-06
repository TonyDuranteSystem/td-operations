/**
 * Mercury Bank Transaction Sync
 * Pulls USD transactions from Mercury API and upserts into td_bank_feeds.
 *
 * Auth: Bearer token (API key as bearer, no login step needed)
 * Accounts: GET /api/v1/accounts
 * Transactions: GET /api/v1/account/{id}/transactions?start={date}&end={date}&limit=500
 *
 * Pattern follows lib/airwallex-sync.ts — upsert by external_id to prevent duplicates.
 * Replaces Plaid for Mercury — direct API gives full sender name, memo, reference.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'

const MERCURY_BASE = 'https://api.mercury.com/api/v1'

interface MercuryAccount {
  id: string
  name: string
  accountNumber: string
  routingNumber: string
  type: string
  status: string
  currentBalance: number
  availableBalance: number
  kind: string
}

interface MercuryTransaction {
  id: string
  amount: number
  status: string
  createdAt: string
  postedAt?: string | null
  note?: string | null
  externalMemo?: string | null
  bankDescription?: string | null
  counterpartyId?: string | null
  counterpartyName?: string | null
  counterpartyNickname?: string | null
  kind?: string  // e.g. 'externalTransfer', 'internalTransfer', 'wire', 'ach'
  dashboardLink?: string | null
  estimatedDeliveryDate?: string | null
  details?: {
    address?: Record<string, unknown>
    domesticWireRoutingInfo?: Record<string, unknown>
    electronicRoutingInfo?: Record<string, unknown>
    [key: string]: unknown
  }
  [key: string]: unknown
}

interface MercurySyncResult {
  accounts: number
  added: number
  skipped: number
  errors: number
  details: string[]
}

function getMercuryToken(): string {
  const token = process.env.MERCURY_API_TOKEN
  if (!token) throw new Error('MERCURY_API_TOKEN not configured')
  return token
}

async function mercuryFetch<T>(path: string): Promise<T> {
  const token = getMercuryToken()
  const res = await fetch(`${MERCURY_BASE}${path}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
    },
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Mercury API error (${res.status} ${path}): ${body}`)
  }

  return res.json()
}

/**
 * List all Mercury accounts.
 */
export async function listMercuryAccounts(): Promise<MercuryAccount[]> {
  const data = await mercuryFetch<{ accounts: MercuryAccount[] }>('/accounts')
  return data.accounts ?? []
}

/**
 * Fetch transactions for a specific Mercury account within a date range.
 */
async function fetchAccountTransactions(
  accountId: string,
  startDate: string,
  endDate: string
): Promise<MercuryTransaction[]> {
  const allTransactions: MercuryTransaction[] = []
  let offset = 0
  const limit = 500
  let hasMore = true

  while (hasMore) {
    const params = new URLSearchParams({
      start: startDate,
      end: endDate,
      limit: String(limit),
      offset: String(offset),
    })

    const data = await mercuryFetch<{ transactions: MercuryTransaction[]; total?: number }>(
      `/account/${accountId}/transactions?${params}`
    )

    const transactions = data.transactions ?? []
    allTransactions.push(...transactions)

    hasMore = transactions.length >= limit
    offset += transactions.length
  }

  return allTransactions
}

/**
 * Sync Mercury transactions into td_bank_feeds.
 * Fetches all accounts, then all transactions within the date range.
 * Upserts by external_id to prevent duplicates.
 */
export async function syncMercuryTransactions(
  fromDate: string,
  toDate: string
): Promise<MercurySyncResult> {
  const accounts = await listMercuryAccounts()
  let added = 0
  let skipped = 0
  let errors = 0
  const details: string[] = []

  details.push(`Found ${accounts.length} Mercury account(s)`)

  for (const account of accounts) {
    if (account.status !== 'active') {
      details.push(`Skipping ${account.name} (status: ${account.status})`)
      continue
    }

    const transactions = await fetchAccountTransactions(account.id, fromDate, toDate)
    details.push(`${account.name}: ${transactions.length} transactions`)

    for (const txn of transactions) {
      try {
        // Skip pending/failed transactions
        if (txn.status && !['sent', 'received', 'completed', 'approved'].includes(txn.status.toLowerCase())) {
          skipped++
          continue
        }

        const amount = Math.abs(Number(txn.amount))
        if (!amount) { skipped++; continue }

        // Determine direction: positive = incoming, negative = outgoing
        const isIncoming = Number(txn.amount) > 0

        const externalId = `mercury_api_${txn.id}`
        const transactionDate = (txn.postedAt || txn.createdAt)?.split('T')[0]
          ?? new Date().toISOString().split('T')[0]

        // Build rich memo from all available fields
        const memoParts = [
          txn.counterpartyName,
          txn.externalMemo,
          txn.bankDescription,
          txn.note,
        ].filter(Boolean)
        const memo = memoParts.join(' — ') || null

        // Extract sender/reference info
        const senderName = isIncoming ? (txn.counterpartyName ?? null) : null
        const senderReference = txn.externalMemo || txn.bankDescription || null

        const { error: upsertErr } = await supabaseAdmin
          .from('td_bank_feeds')
          .upsert({
            source: 'mercury_api',
            external_id: externalId,
            transaction_date: transactionDate,
            amount,
            currency: 'USD',
            sender_name: senderName,
            sender_reference: senderReference,
            memo,
            raw_data: txn as unknown as Record<string, unknown>,
            status: isIncoming ? 'unmatched' : 'outgoing',
          }, { onConflict: 'external_id' })

        if (upsertErr) {
          console.error(`[mercury-sync] Upsert error for ${txn.id}:`, upsertErr.message)
          errors++
        } else {
          added++
        }
      } catch (err) {
        console.error(`[mercury-sync] Error processing txn ${txn.id}:`, err)
        errors++
      }
    }
  }

  return { accounts: accounts.length, added, skipped, errors, details }
}
