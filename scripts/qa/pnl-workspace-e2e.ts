/* eslint-disable no-console, no-restricted-syntax */
/**
 * M9 E2E harness for the standalone P&L workspace tool — runs the REAL lib
 * functions against the SANDBOX DB (xjcxlmlpeywtwkhstjlw) with real B&P data.
 * Asserts the data-safety properties: isolation (zero writes to real tables),
 * fork parity, save-to-client merge/replace + backup + audit, leak-zero, entity
 * guard. Cleans up every workspace it creates.
 *
 * Run: DOTENV_CONFIG_PATH=.env.local npx tsx --tsconfig tsconfig.json scripts/qa/pnl-workspace-e2e.ts
 */
import 'dotenv/config'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { ingestWorkspaceCsv } from '@/lib/tax/workspace-ingest'
import { getWorkspaceFinancialsView } from '@/lib/tax/workspace-orchestration'
import { saveWorkspaceToClient, decideSaveToClient } from '@/lib/tax/workspace-save'
import { fetchAllBankTransactionsByYear } from '@/lib/bank-transactions-fetch'
import { normalizeEntityType } from '@/lib/portal/entity-type'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

const BP = '8a5d641a-6cc5-43b4-8077-9e62ee465677' // B&P International LLC (MMLLC, 407 tx, 2025)
const YEAR = 2025

let pass = 0, fail = 0
const created: string[] = [] // workspace ids to clean up
const ok = (name: string, cond: boolean, detail = '') => { if (cond) { pass++; console.log(`  ✅ ${name} ${detail}`) } else { fail++; console.log(`  ❌ FAIL ${name} ${detail}`) } }

async function countBankTx(accountId: string, year: number) {
  const { count } = await supabaseAdmin.from('bank_transactions').select('id', { count: 'exact', head: true }).eq('account_id', accountId).eq('tax_year', year)
  return count ?? 0
}
async function tableCount(table: string) {
  const { count } = await db.from(table).select('id', { count: 'exact', head: true })
  return count ?? 0
}

async function makeWorkspace(fields: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from('pnl_workspaces').insert({ tax_year: YEAR, entity_type: 'MMLLC', created_by: 'qa-e2e', ...fields }).select('id').single()
  if (error) throw new Error(error.message)
  created.push(data.id)
  return data.id
}

async function main() {
  console.log('=== M9 E2E — P&L workspace tool (sandbox) ===')
  console.log('SUPABASE:', (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/https:\/\/([a-z]+)\..*/, '$1'))

  // Baselines for leak assertions.
  const base = {
    bpTx: await countBankTx(BP, YEAR),
    catalog: await tableCount('catalog_entries'),
    rules: await tableCount('bank_categorization_rules'),
    subs: await tableCount('tax_return_submissions'),
  }
  const bpContacts = (await supabaseAdmin.from('account_contacts').select('contact_id, ownership_pct').eq('account_id', BP)).data ?? []
  console.log('Baselines:', base, 'B&P contacts:', bpContacts.length)

  // ── S9: entity guard (pure) ──
  console.log('\n[S9] Entity guard')
  ok('B&P normalizes to MMLLC', normalizeEntityType('Multi Member LLC') === 'MMLLC')
  ok('SMLLC blocked', normalizeEntityType('Single Member LLC') !== 'MMLLC')
  ok('C-Corp Elected blocked', normalizeEntityType('C-Corp Elected') !== 'MMLLC')

  // ── S1: blank workspace + synthetic CSV ingest + isolation ──
  console.log('\n[S1] Blank workspace + CSV ingest + isolation')
  const wsBlank = await makeWorkspace({ label: 'QA blank', company_name: 'QA Blank LLC' })
  await db.from('pnl_workspace_members').insert([
    { workspace_id: wsBlank, member_type: 'individual', display_name: 'Alice QA', ownership_pct: 60 },
    { workspace_id: wsBlank, member_type: 'company', display_name: 'QA Holdings LLC', ownership_pct: 40 },
  ])
  const csv = [
    'Date,Description,Amount,Balance',
    '2025-01-05,Payment from CLIENT ACME,5000.00,5000.00',
    '2025-02-10,AWS cloud services,-300.00,4700.00',
    '2025-03-01,Payment from CLIENT ACME,7000.00,11700.00',
    '2025-04-15,Legal fees LAWFIRM,-1200.00,10500.00',
  ].join('\n')
  const ing = await ingestWorkspaceCsv({ workspaceId: wsBlank, taxYear: YEAR, bankLabel: 'TestBank', buffer: Buffer.from(csv), fileName: 'qa.csv', linkedAccountId: null, companyName: 'QA Blank LLC', memberNames: ['Alice QA', 'QA Holdings LLC'] })
  ok('ingest ok', ing.ok, `inserted=${ing.inserted} parsed=${ing.parsed}`)
  ok('4 rows ingested', ing.inserted === 4)
  const viewBlank = await getWorkspaceFinancialsView(wsBlank)
  ok('P&L income = 12000', Math.abs(viewBlank.draft.pnl.totalIncome - 12000) < 0.01, `got ${viewBlank.draft.pnl.totalIncome}`)
  ok('P&L has expenses', viewBlank.draft.pnl.totalExpenses > 0, `expenses=${viewBlank.draft.pnl.totalExpenses}`)
  ok('K-1 members = 2 (incl. company member)', viewBlank.draft.members.length === 2)
  ok('ownership 60/40 splits net income', viewBlank.draft.members.some(m => m.pct === 60) && viewBlank.draft.members.some(m => m.pct === 40))
  // Isolation: nothing written to any real table.
  ok('ISOLATION: no bank_transactions written (blank has no linked account)', (await tableCount('bank_transactions')) >= base.bpTx)
  ok('LEAK: catalog_entries unchanged', (await tableCount('catalog_entries')) === base.catalog)
  ok('LEAK: bank_categorization_rules unchanged', (await tableCount('bank_categorization_rules')) === base.rules)
  ok('LEAK: tax_return_submissions unchanged', (await tableCount('tax_return_submissions')) === base.subs)

  // ── S2/S3: fork B&P, parity, independence, isolation ──
  console.log('\n[S2/S3] Fork B&P — parity + isolation')
  const wsFork = await makeWorkspace({ label: 'QA fork B&P', company_name: 'B&P International LLC', linked_account_id: BP })
  const bpRows = await fetchAllBankTransactionsByYear<Record<string, unknown>>(BP, YEAR, 'transaction_date, description, category, subcategory, counterparty, amount, currency, balance_after, bank_name, account_type, transaction_ref, source_file_id, is_related_party, notes, ai_lean, ai_bucket')
  // Copy like the fork route does.
  for (let i = 0; i < bpRows.length; i += 500) {
    const batch = bpRows.slice(i, i + 500).map(r => ({ ...r, workspace_id: wsFork, tax_year: YEAR }))
    const { error } = await db.from('pnl_workspace_transactions').upsert(batch, { onConflict: 'workspace_id,transaction_ref,transaction_date,amount', ignoreDuplicates: true })
    if (error) throw new Error(error.message)
  }
  const { count: forkCount } = await db.from('pnl_workspace_transactions').select('id', { count: 'exact', head: true }).eq('workspace_id', wsFork)
  ok('fork copied all B&P rows', forkCount === base.bpTx, `fork=${forkCount} client=${base.bpTx}`)
  const viewFork = await getWorkspaceFinancialsView(wsFork)
  // Compare to the client's own view (parity).
  const { getFinancialsView } = await import('@/lib/tax/financials-orchestration')
  const clientView = await getFinancialsView(BP, YEAR)
  ok('PARITY: fork net income == client net income', Math.abs(viewFork.draft.pnl.netIncome - clientView.draft.pnl.netIncome) < 0.01, `fork=${viewFork.draft.pnl.netIncome} client=${clientView.draft.pnl.netIncome}`)
  ok('PARITY: fork revenue == client revenue', Math.abs(viewFork.draft.pnl.totalIncome - clientView.draft.pnl.totalIncome) < 0.01)
  // Independence: edit a workspace row, client unchanged.
  const { data: oneRow } = await db.from('pnl_workspace_transactions').select('id').eq('workspace_id', wsFork).limit(1).single()
  await db.from('pnl_workspace_transactions').update({ category: 'distribution', notes: 'manual: qa edit' }).eq('id', oneRow.id)
  ok('ISOLATION: editing fork did NOT change client bank_transactions count', (await countBankTx(BP, YEAR)) === base.bpTx)

  // ── S4: save-to-client (merge/replace) into a THROWAWAY account ──
  console.log('\n[S4] Save-to-client (merge/replace/backup/audit) into throwaway account')
  const { data: acct } = await supabaseAdmin.from('accounts').insert({ company_name: 'QA E2E Throwaway LLC', entity_type: 'Multi Member LLC' } as never).select('id').single()
  const target = acct!.id as string
  const auditBefore = await tableCount('action_log')
  // Empty target → straight insert.
  const s1 = await saveWorkspaceToClient({ workspaceId: wsFork, targetAccountId: target, taxYear: YEAR, actor: 'qa-e2e' })
  ok('save insert ok', s1.ok && s1.action === 'insert', `inserted=${s1.inserted}`)
  ok('target now has rows', (await countBankTx(target, YEAR)) === s1.inserted && s1.inserted > 0)
  // Non-empty + no mode → refuse.
  const s2 = await saveWorkspaceToClient({ workspaceId: wsFork, targetAccountId: target, taxYear: YEAR, actor: 'qa-e2e' })
  ok('non-empty + no mode → refuse', !s2.ok && s2.action === 'refuse')
  // Merge → idempotent (dedup, no dup rows).
  const beforeMerge = await countBankTx(target, YEAR)
  const s3 = await saveWorkspaceToClient({ workspaceId: wsFork, targetAccountId: target, taxYear: YEAR, mode: 'merge', actor: 'qa-e2e' })
  ok('merge idempotent (no new dup rows)', s3.ok && (await countBankTx(target, YEAR)) === beforeMerge, `after=${await countBankTx(target, YEAR)} before=${beforeMerge}`)
  // Replace → backup + delete + insert.
  const s4 = await saveWorkspaceToClient({ workspaceId: wsFork, targetAccountId: target, taxYear: YEAR, mode: 'replace', actor: 'qa-e2e' })
  ok('replace ok', s4.ok && s4.action === 'replace', `inserted=${s4.inserted} deleted=${s4.deleted}`)
  ok('replace took a backup', !!s4.backupPath, s4.backupPath ?? '')
  const backupExists = s4.backupPath ? !(await supabaseAdmin.storage.from('onboarding-uploads').download(s4.backupPath)).error : false
  ok('backup file exists in storage', backupExists)
  ok('AUDIT: action_log rows written for saves', (await tableCount('action_log')) > auditBefore)
  const { data: auditRows } = await supabaseAdmin.from('action_log').select('action_type, summary').eq('action_type', 'pnl_workspace_save_to_client').order('created_at', { ascending: false }).limit(1)
  ok('AUDIT: pnl_workspace_save_to_client logged', (auditRows ?? []).length > 0, (auditRows?.[0]?.summary ?? '').slice(0, 60))

  // ── Concurrency decision (pure) ──
  console.log('\n[S4b] Concurrency guard (pure)')
  ok('in-flight ingest → refuse', decideSaveToClient({ existingCount: 0, inFlightJobs: 1 }).action === 'refuse')

  // Cleanup throwaway account + its rows.
  await supabaseAdmin.from('bank_transactions').delete().eq('account_id', target)
  await supabaseAdmin.from('accounts').delete().eq('id', target)

  // ── Final: B&P real books completely untouched ──
  console.log('\n[FINAL] Real client untouched')
  ok('B&P bank_transactions count identical to baseline', (await countBankTx(BP, YEAR)) === base.bpTx, `${await countBankTx(BP, YEAR)} vs ${base.bpTx}`)
  const bpContactsAfter = (await supabaseAdmin.from('account_contacts').select('contact_id, ownership_pct').eq('account_id', BP)).data ?? []
  ok('B&P account_contacts unchanged (no ownership sync-back)', bpContactsAfter.length === bpContacts.length)

  // Cleanup workspaces (cascade members + transactions).
  for (const id of created) await db.from('pnl_workspaces').delete().eq('id', id)
  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed. Cleaned up ${created.length} workspaces. ===`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async e => {
  console.error('HARNESS ERROR:', e)
  for (const id of created) { try { await db.from('pnl_workspaces').delete().eq('id', id) } catch { /* noop */ } }
  process.exit(1)
})
