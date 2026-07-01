/**
 * POST /api/tools/pnl/generate — existing-client P&L, staff tool (/tools/pnl).
 *
 * Generates the 5-sheet P&L / Balance Sheet for a CRM account + tax year using
 * the ONE shared engine (generatePnlExcel), streams the .xlsx back as a
 * download, and — when save_to_drive is on — also files it in the account's
 * Drive "3. Tax/{year}" folder (same as the bank_statement_pnl MCP tool).
 *
 * Multipart FormData: account_id (uuid), tax_year (int), save_to_drive ("true"/"false").
 *
 * IMPORTANT (deliberate design, see plan): this route does NOT parse/ingest bank
 * statements. It only reads already-processed bank_transactions via the engine.
 * If none exist for the year it returns a clear 422 pointing at the existing
 * ingest paths — it never runs the heavy synchronous parse+categorize+AI work in
 * the request (that pattern caused a real serverless-timeout outage on the
 * portal upload route; see docs/systems/tax-returns.md).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { generatePnlExcel } from '@/lib/pnl-generator'
import { findTaxFolder, uploadBinaryToDrive } from '@/lib/google-drive'
import { logAction } from '@/lib/mcp/action-log'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) {
    return NextResponse.json({ error: 'Dashboard access required' }, { status: 403 })
  }

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json({ error: 'Expected multipart form data.' }, { status: 400 })
  }

  const accountId = String(form.get('account_id') || '').trim()
  const taxYear = Number(form.get('tax_year'))
  const saveToDrive = String(form.get('save_to_drive') || 'true') === 'true'

  if (!accountId) {
    return NextResponse.json({ error: 'Pick a client account first.' }, { status: 400 })
  }
  if (!Number.isInteger(taxYear) || taxYear < 2000 || taxYear > 2100) {
    return NextResponse.json({ error: 'Enter a valid tax year.' }, { status: 400 })
  }

  // Build the workbook via the shared engine. It throws a specific message when
  // the account/year has no processed transactions — surface that as actionable
  // guidance rather than attempting any inline ingestion.
  let result
  try {
    result = await generatePnlExcel(accountId, taxYear)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/no transactions/i.test(msg)) {
      return NextResponse.json(
        {
          error: `No processed bank transactions for this client in ${taxYear}. Process the client's statements first (bank_statement_process, or the client's tax wizard), then generate the P&L.`,
        },
        { status: 422 },
      )
    }
    console.error('[tools/pnl/generate] failed:', e)
    return NextResponse.json({ error: `Could not generate the P&L: ${msg}` }, { status: 500 })
  }

  // Optionally file it in the account's Drive "3. Tax/{year}" folder.
  let driveLink = ''
  if (saveToDrive) {
    try {
      const { data: account } = await supabaseAdmin
        .from('accounts')
        .select('company_name, drive_folder_id')
        .eq('id', accountId)
        .single()
      if (account?.drive_folder_id) {
        const taxFolderId = await findTaxFolder(account.drive_folder_id)
        const targetFolder = taxFolderId || account.drive_folder_id
        const uploaded = (await uploadBinaryToDrive(
          result.fileName, result.buffer, XLSX_MIME, targetFolder,
        )) as { id: string; name: string }
        driveLink = `https://drive.google.com/file/d/${uploaded.id}/view`
        logAction({
          action_type: 'tools_pnl_generate',
          table_name: 'bank_transactions',
          record_id: accountId,
          summary: `Generated P&L for ${account.company_name || accountId} (${taxYear}) via /tools/pnl, saved to Drive`,
          details: { drive_file_id: uploaded.id, net_income: result.netIncome, tax_year: taxYear },
        })
      }
    } catch (e) {
      // Drive save is best-effort — never fail the download over it.
      console.error('[tools/pnl/generate] Drive save failed (download still returned):', e)
    }
  }

  const safeName = result.fileName.replace(/[^a-zA-Z0-9._ -]/g, '')
  return new NextResponse(new Uint8Array(result.buffer), {
    headers: {
      'Content-Type': XLSX_MIME,
      'Content-Disposition': `attachment; filename="${safeName}"`,
      ...(driveLink ? { 'X-Drive-Link': driveLink } : {}),
    },
  })
}
