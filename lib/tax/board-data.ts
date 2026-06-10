/**
 * Tax Board data fetch (Slice 6). Server-side only.
 *
 * Returns the catalog board columns (pipeline_stages.board_visible) plus one
 * card per in-flight Tax Return service delivery, joined to its account,
 * its tax_returns row (matched by company_name + tax_year — there is no FK),
 * and its latest submission's review_status (for the column overlay).
 *
 * Pure grouping/coloring lives in lib/tax/tax-board.ts; this module only does
 * I/O, so it follows the codebase pattern of integration-tested-not-unit.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
import type { BoardCard, BoardColumnDef } from '@/lib/tax/tax-board'

export interface TaxBoardData {
  columns: BoardColumnDef[]
  cards: BoardCard[]
  /** Cards whose effective stage falls outside the board columns. */
  year: number
}

export async function getTaxBoardData(
  supabase: SupabaseClient<Database>,
  year: number,
): Promise<TaxBoardData> {
  const [stageRes, sdRes, trRes, subRes] = await Promise.all([
    supabase
      .from('pipeline_stages')
      .select('stage_name, stage_order, client_label, icon, color, stale_days')
      .eq('service_type', 'Tax Return')
      .eq('board_visible', true)
      .order('stage_order', { ascending: true }),
    supabase
      .from('service_deliveries')
      .select('id, account_id, stage, stage_entered_at, assigned_to, status, accounts(company_name, entity_type)')
      .eq('service_type', 'Tax Return')
      .not('status', 'in', '(completed,cancelled)'),
    supabase
      .from('tax_returns')
      .select('company_name, tax_year, return_type, deadline, paid, extension_filed')
      .eq('tax_year', year),
    supabase
      .from('tax_return_submissions')
      .select('account_id, tax_year, review_status, created_at')
      .eq('tax_year', year)
      .order('created_at', { ascending: false }),
  ])

  const columns: BoardColumnDef[] = (stageRes.data ?? []).map(s => ({
    stage_name: s.stage_name,
    stage_order: s.stage_order,
    client_label: s.client_label,
    icon: s.icon,
    color: s.color,
    stale_days: s.stale_days,
  }))

  // tax_returns indexed by lowercased company_name (1 per company for the year).
  type TrRow = NonNullable<typeof trRes.data>[number]
  const trByCompany = new Map<string, TrRow>()
  for (const tr of trRes.data ?? []) {
    if (tr.company_name) trByCompany.set(tr.company_name.toLowerCase(), tr)
  }

  // latest submission per account (rows are newest-first, so first wins).
  const subByAccount = new Map<string, string | null>()
  for (const sub of subRes.data ?? []) {
    if (sub.account_id && !subByAccount.has(sub.account_id)) {
      subByAccount.set(sub.account_id, sub.review_status)
    }
  }

  const cards: BoardCard[] = (sdRes.data ?? []).map(sd => {
    // supabase types the nested relation as object | array depending on cardinality;
    // account_id → accounts.id is to-one, so coerce defensively.
    const acct = Array.isArray(sd.accounts) ? sd.accounts[0] : sd.accounts
    const companyName = acct?.company_name ?? null
    const tr = companyName ? trByCompany.get(companyName.toLowerCase()) ?? null : null
    return {
      sdId: sd.id,
      accountId: sd.account_id,
      companyName,
      entityType: acct?.entity_type ?? null,
      sdStage: sd.stage,
      stageEnteredAt: sd.stage_entered_at,
      reviewStatus: sd.account_id ? subByAccount.get(sd.account_id) ?? null : null,
      taxYear: tr?.tax_year ?? null,
      returnType: tr?.return_type ?? null,
      deadline: tr?.deadline ?? null,
      paid: tr?.paid ?? null,
      extensionFiled: tr?.extension_filed ?? null,
      assignedTo: sd.assigned_to,
    }
  })

  return { columns, cards, year }
}
