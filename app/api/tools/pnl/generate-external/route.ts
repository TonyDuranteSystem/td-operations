/**
 * POST /api/tools/pnl/generate-external — ad-hoc P&L for a company that is NOT
 * a CRM account. Staff tool (/tools/pnl, "External" mode).
 *
 * The operator types the company name + members (ownership %) and uploads bank
 * CSV(s) for the year (and optionally the prior year, for the comparative
 * balance sheet). We parse the CSVs ENTIRELY IN MEMORY (deterministic parsers
 * only — no AI, no timeout risk) and build the workbook with the SAME shared
 * engine (buildPnlWorkbook), then stream the .xlsx back.
 *
 * CORE SAFETY PROPERTY: this route writes NOTHING to the database. There is no
 * CRM account, and bank_transactions.account_id is FK-bound to accounts, so the
 * parsed rows exist only in memory. The only DB touch is a READ of the global
 * irs_exchange_rates table for currency conversion.
 *
 * CSV only for v1 (PDF can fall back to ~250s AI extraction — unsafe in a
 * synchronous request; a stated future enhancement).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { buildPnlWorkbook, getIrsRate } from '@/lib/pnl-generator'
import { parseExternalStatements, type ExternalCsvFile } from '@/lib/pnl-external'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const MAX_FILE_BYTES = 10 * 1024 * 1024 // 10 MB per file

interface MemberInput { name: string; ownership_pct: number }

/** Pull uploaded files from a FormData field, validating CSV + size. Returns
 *  either the files or a user-facing error string. */
async function collectCsvFiles(form: FormData, field: string): Promise<{ files: ExternalCsvFile[] } | { error: string }> {
  const entries = form.getAll(field).filter((v): v is File => v instanceof File && v.size > 0)
  const files: ExternalCsvFile[] = []
  for (const f of entries) {
    const isCsv = f.type === 'text/csv' || f.name.toLowerCase().endsWith('.csv')
    if (!isCsv) {
      return { error: `"${f.name}" is not a CSV. External mode accepts CSV bank exports only (PDF support is coming later).` }
    }
    if (f.size > MAX_FILE_BYTES) {
      return { error: `"${f.name}" is larger than 10 MB. Split the export or trim it.` }
    }
    files.push({ fileName: f.name, mimeType: f.type || 'text/csv', buffer: Buffer.from(await f.arrayBuffer()) })
  }
  return { files }
}

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

  const companyName = String(form.get('company_name') || '').trim()
  const taxYear = Number(form.get('tax_year'))

  if (!companyName) {
    return NextResponse.json({ error: 'Enter the company name.' }, { status: 400 })
  }
  if (!Number.isInteger(taxYear) || taxYear < 2000 || taxYear > 2100) {
    return NextResponse.json({ error: 'Enter a valid tax year.' }, { status: 400 })
  }

  // Members + ownership. Must sum to 100% (±0.5) — same tolerance as the tax wizard.
  let members: MemberInput[]
  try {
    const raw = JSON.parse(String(form.get('members') || '[]'))
    if (!Array.isArray(raw)) throw new Error('not an array')
    members = raw
      .map((m: { name?: unknown; ownership_pct?: unknown }) => ({
        name: String(m.name ?? '').trim(),
        ownership_pct: Number(m.ownership_pct),
      }))
      .filter(m => m.name.length > 0)
  } catch {
    return NextResponse.json({ error: 'Members list is malformed.' }, { status: 400 })
  }
  if (members.length === 0) {
    return NextResponse.json({ error: 'Add at least one member with an ownership %.' }, { status: 400 })
  }
  if (members.some(m => !Number.isFinite(m.ownership_pct) || m.ownership_pct < 0)) {
    return NextResponse.json({ error: 'Every member needs a valid ownership % (0 or greater).' }, { status: 400 })
  }
  const ownershipSum = members.reduce((s, m) => s + m.ownership_pct, 0)
  if (Math.abs(ownershipSum - 100) > 0.5) {
    return NextResponse.json(
      { error: `Ownership must total 100% (currently ${ownershipSum.toFixed(1)}%).` },
      { status: 400 },
    )
  }

  const current = await collectCsvFiles(form, 'files')
  if ('error' in current) return NextResponse.json({ error: current.error }, { status: 400 })
  if (current.files.length === 0) {
    return NextResponse.json({ error: 'Upload at least one CSV bank statement for the year.' }, { status: 400 })
  }
  const prior = await collectCsvFiles(form, 'prior_files')
  if ('error' in prior) return NextResponse.json({ error: prior.error }, { status: 400 })

  const memberNames = members.map(m => m.name)

  try {
    const cur = await parseExternalStatements(current.files, memberNames, taxYear)
    if (cur.transactions.length === 0) {
      return NextResponse.json(
        {
          error: `No transactions could be read from the uploaded CSV(s) for ${taxYear}. `
            + `Check the file is a standard bank CSV export for that year.`
            + (cur.errors.length ? ` Details: ${cur.errors.slice(0, 3).join('; ')}` : ''),
        },
        { status: 422 },
      )
    }
    const pri = prior.files.length
      ? await parseExternalStatements(prior.files, memberNames, taxYear - 1)
      : { transactions: [], currencies: [], errors: [], emptyFiles: 0 }

    // IRS rates (read-only global table) for every currency present.
    const rates: Record<string, number> = {}
    for (const c of cur.currencies) rates[c] = await getIrsRate(c, taxYear)
    const priorRates: Record<string, number> = {}
    for (const c of pri.currencies) priorRates[c] = await getIrsRate(c, taxYear - 1)

    const result = await buildPnlWorkbook({
      companyName,
      members: members.map(m => ({ name: m.name, ownership_pct: m.ownership_pct })),
      taxYear,
      transactions: cur.transactions,
      priorTransactions: pri.transactions,
      rates,
      priorRates,
    })

    const safeName = result.fileName.replace(/[^a-zA-Z0-9._ -]/g, '')
    return new NextResponse(new Uint8Array(result.buffer), {
      headers: {
        'Content-Type': XLSX_MIME,
        'Content-Disposition': `attachment; filename="${safeName}"`,
      },
    })
  } catch (e) {
    console.error('[tools/pnl/generate-external] failed:', e)
    return NextResponse.json({ error: `Could not generate the P&L: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 })
  }
}
