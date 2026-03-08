/**
 * Supabase → Airtable One-Way Sync
 * Supabase is the source of truth. Pushes account data to Airtable.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

const AIRTABLE_BASE = "apppWyKkOSZXQE6s8"
const AIRTABLE_TABLE = "tblf1e3aeIta34k3y"
const AIRTABLE_API = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}`

// Supabase column → Airtable field ID
const FIELD_MAP = {
  company_name: "fldElh878y8i1SAnV",
  entity_type: "fldoGecCLqKpVXo9c",
  status: "fldni7xY7uDlZOVcr",
  ein_number: "fldkxz2FqSVcxOEfz",
  filing_id: "fldUm1vbgQplMvTnA",
  formation_date: "fldxOGpfHW3pONaTr",
  state_of_formation: "fld8zQ0S1LLs1Ka80",
  physical_address: "flds57tOANaqowijS",
  registered_agent_provider: "fldCsli5PXNn0E4va",
  ra_renewal_date: "fldusQs6Krw2OvU8k",
  portal_account: "fld9nz9LrKaTB8BVY",
  portal_created_date: "fldD6AT2tzcX6JHoZ",
  services_bundle: "fld2kUg1ZvwaudZzW",
  installment_1_amount: "fldV2pJLcBGIdaLf6",
  installment_2_amount: "fldjFIAK22qXkUyhN",
  cancellation_requested: "fldgOHRuVb5lLGBM6",
  cancellation_date: "fldzFUvIPUiUolOwe",
  referrer: "fldQlrpSaYuUwJjA6",
  lead_source: "fld5gXeovuFvhGty4",
  notes: "fldYxXmBQJOzicTev",
  annual_report_due_date: "fldVk2UviFNDTquYt",
  cmra_amount: "fldWB2cRQDROCBNqz",
} as const

// Supabase account_status → Airtable Status singleSelect
const STATUS_MAP: Record<string, string> = {
  Active: "Active",
  "Pending Formation": "Active", // no direct match, closest is Active
  Delinquent: "Payment Delinquent",
  Suspended: "Inactive",
  Cancelled: "Cancelled",
  Closed: "Closed",
}

// Supabase state → Airtable State of Formation singleSelect
const KNOWN_STATES = new Set(["Wyoming", "Florida", "Delaware", "New Mexico", "Texas"])

function mapAccountToAirtable(account: Record<string, unknown>): Record<string, unknown> {
  const f: Record<string, unknown> = {}

  // Text fields — only push non-null
  const textFields = [
    "company_name",
    "ein_number",
    "filing_id",
    "physical_address",
    "registered_agent_provider",
    "referrer",
    "lead_source",
    "notes",
  ] as const
  for (const key of textFields) {
    if (account[key]) f[FIELD_MAP[key]] = account[key]
  }

  // entity_type — 1:1 match (same enum labels)
  if (account.entity_type) {
    f[FIELD_MAP.entity_type] = account.entity_type as string
  }

  // status — mapped
  if (account.status) {
    const mapped = STATUS_MAP[account.status as string]
    if (mapped) f[FIELD_MAP.status] = mapped
  }

  // state_of_formation — known states or "Other"
  if (account.state_of_formation) {
    const st = account.state_of_formation as string
    f[FIELD_MAP.state_of_formation] = KNOWN_STATES.has(st) ? st : "Other"
  }

  // Date fields
  const dateFields = [
    "formation_date",
    "ra_renewal_date",
    "portal_created_date",
    "cancellation_date",
    "annual_report_due_date",
  ] as const
  for (const key of dateFields) {
    if (account[key]) f[FIELD_MAP[key]] = account[key] as string
  }

  // Boolean fields
  if (account.portal_account != null) {
    f[FIELD_MAP.portal_account] = !!account.portal_account
  }
  if (account.cancellation_requested != null) {
    f[FIELD_MAP.cancellation_requested] = !!account.cancellation_requested
  }

  // Currency fields
  if (account.installment_1_amount != null) {
    f[FIELD_MAP.installment_1_amount] = Number(account.installment_1_amount)
  }
  if (account.installment_2_amount != null) {
    f[FIELD_MAP.installment_2_amount] = Number(account.installment_2_amount)
  }
  if (account.cmra_amount != null) {
    f[FIELD_MAP.cmra_amount] = Number(account.cmra_amount)
  }

  // services_bundle — text[] → multipleSelects
  if (Array.isArray(account.services_bundle) && account.services_bundle.length > 0) {
    f[FIELD_MAP.services_bundle] = account.services_bundle
  }

  return f
}

async function updateAirtableBatch(
  pat: string,
  records: { id: string; fields: Record<string, unknown> }[]
): Promise<{ updatedCount: number; errors: string[] }> {
  const resp = await fetch(AIRTABLE_API, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${pat}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ records, typecast: true }),
  })

  if (!resp.ok) {
    const errText = await resp.text()
    return { updatedCount: 0, errors: [`HTTP ${resp.status}: ${errText.substring(0, 300)}`] }
  }

  const data = await resp.json()
  return { updatedCount: data.records?.length || 0, errors: [] }
}

export interface SyncStats {
  total: number
  synced: number
  skipped: number
  failed: number
  errors: string[]
  elapsed_ms: number
}

export async function syncSupabaseToAirtable(options?: {
  dry_run?: boolean
  limit?: number
}): Promise<SyncStats> {
  const start = Date.now()
  const pat = process.env.AIRTABLE_PAT
  if (!pat) throw new Error("AIRTABLE_PAT env var not set")

  const dryRun = options?.dry_run ?? false
  const limit = options?.limit ?? 0

  // Fetch all accounts with airtable_id
  let q = supabaseAdmin
    .from("accounts")
    .select("*")
    .not("airtable_id", "is", null)
    .order("company_name")

  if (limit > 0) q = q.limit(limit)

  const { data: accounts, error } = await q
  if (error) throw new Error(`Supabase query: ${error.message}`)
  if (!accounts?.length) {
    return { total: 0, synced: 0, skipped: 0, failed: 0, errors: [], elapsed_ms: Date.now() - start }
  }

  const stats: SyncStats = { total: accounts.length, synced: 0, skipped: 0, failed: 0, errors: [], elapsed_ms: 0 }

  // Build records to sync
  const records: { id: string; fields: Record<string, unknown> }[] = []
  for (const acc of accounts) {
    const fields = mapAccountToAirtable(acc)
    if (Object.keys(fields).length === 0) {
      stats.skipped++
      continue
    }
    records.push({ id: acc.airtable_id, fields })
  }

  if (dryRun) {
    stats.synced = records.length
    stats.elapsed_ms = Date.now() - start
    return stats
  }

  // Batch update in groups of 10 (Airtable limit)
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10)
    const result = await updateAirtableBatch(pat, batch)
    stats.synced += result.updatedCount
    if (result.errors.length) {
      stats.failed += batch.length - result.updatedCount
      stats.errors.push(...result.errors)
    }

    // Rate limit: Airtable allows 5 req/sec, be safe with 250ms delay
    if (i + 10 < records.length) {
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  stats.elapsed_ms = Date.now() - start
  return stats
}
