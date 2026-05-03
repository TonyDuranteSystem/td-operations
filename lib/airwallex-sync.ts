/**
 * Airwallex Deposit Sync
 * Pulls EUR deposits from Airwallex API and upserts into td_bank_feeds.
 *
 * Auth: POST /authentication/login with x-api-key + x-client-id → 30min bearer token
 * Deposits: GET /deposits with date range, paginated
 *
 * Pattern follows lib/plaid-sync.ts — upsert by external_id to prevent duplicates.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import type { Json } from '@/lib/database.types'

const AIRWALLEX_BASE = 'https://api.airwallex.com/api/v1'

interface AirwallexDeposit {
  // The API returns either `id` or `deposit_id` depending on endpoint version.
  id?: string
  deposit_id?: string
  amount: number
  currency: string
  status: string
  created_at: string
  deposited_at?: string
  settled_at?: string
  // Real API returns `payer_name` (top-level) and `statement_ref`.
  // Older shapes used `sender.name` + `reference` — keep both as fallbacks.
  payer_name?: string
  statement_ref?: string
  sender?: {
    name?: string
    account_number?: string
    bank_name?: string
  }
  reference?: string
  [key: string]: unknown
}

interface AirwallexSyncResult {
  added: number
  skipped: number
  errors: number
}

/**
 * Authenticate with Airwallex API.
 * Returns a bearer token valid for 30 minutes.
 */
async function getAirwallexToken(): Promise<string> {
  const clientId = process.env.AIRWALLEX_CLIENT_ID
  const apiKey = process.env.AIRWALLEX_API_KEY

  if (!clientId || !apiKey) {
    throw new Error('Airwallex credentials not configured (AIRWALLEX_CLIENT_ID, AIRWALLEX_API_KEY)')
  }

  const res = await fetch(`${AIRWALLEX_BASE}/authentication/login`, {
    method: 'POST',
    headers: {
      'x-client-id': clientId,
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
    },
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Airwallex auth failed (${res.status}): ${body}`)
  }

  const data = await res.json()
  return data.token as string
}

/**
 * Sync Airwallex deposits into td_bank_feeds.
 * Fetches deposits within the given date range and upserts by external_id.
 */
export async function syncAirwallexDeposits(
  fromDate: string,
  toDate: string
): Promise<AirwallexSyncResult> {
  const token = await getAirwallexToken()

  let pageNum = 0
  const pageSize = 100
  let hasMore = true
  let added = 0
  let skipped = 0
  let errors = 0

  while (hasMore) {
    const params = new URLSearchParams({
      from_created_date: fromDate,
      to_created_date: toDate,
      page_num: String(pageNum),
      page_size: String(pageSize),
    })

    const res = await fetch(`${AIRWALLEX_BASE}/deposits?${params}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    })

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Airwallex deposits fetch failed (${res.status}): ${body}`)
    }

    const data = await res.json()
    const deposits: AirwallexDeposit[] = data.items ?? []

    for (const deposit of deposits) {
      try {
        // Skip non-completed deposits
        if (deposit.status && !['RECEIVED', 'COMPLETED', 'SETTLED'].includes(deposit.status.toUpperCase())) {
          skipped++
          continue
        }

        const depositId = deposit.deposit_id ?? deposit.id
        if (!depositId) {
          skipped++
          continue
        }
        const externalId = `airwallex_${depositId}`
        const amount = Number(deposit.amount)
        if (!amount || amount <= 0) {
          skipped++
          continue
        }

        // Prefer settled_at over deposited_at over created_at for transaction_date.
        const transactionDate = (deposit.settled_at ?? deposit.deposited_at ?? deposit.created_at)
          ?.split('T')[0] ?? new Date().toISOString().split('T')[0]

        // Real API returns payer_name + statement_ref; legacy shape used sender.name + reference.
        const senderName = deposit.payer_name ?? deposit.sender?.name ?? null
        const senderReference = deposit.statement_ref ?? deposit.reference ?? null

        const { error: upsertErr } = await supabaseAdmin
          .from('td_bank_feeds')
          .upsert({
            source: 'airwallex_api',
            external_id: externalId,
            transaction_date: transactionDate,
            amount,
            currency: deposit.currency || 'EUR',
            sender_name: senderName,
            sender_reference: senderReference,
            memo: [senderName, senderReference].filter(Boolean).join(' — '),
            raw_data: deposit as unknown as Json,
            status: 'unmatched',
          }, { onConflict: 'external_id' })

        if (upsertErr) {
          console.error(`[airwallex-sync] Upsert error for ${depositId}:`, upsertErr.message)
          errors++
        } else {
          added++
        }
      } catch (err) {
        console.error(`[airwallex-sync] Error processing deposit ${deposit.deposit_id ?? deposit.id ?? '<no-id>'}:`, err)
        errors++
      }
    }

    // Check if there are more pages
    hasMore = deposits.length >= pageSize
    pageNum++
  }

  return { added, skipped, errors }
}
