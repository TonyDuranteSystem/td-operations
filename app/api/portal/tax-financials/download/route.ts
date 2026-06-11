/**
 * GET /api/portal/tax-financials/download?account_id=&tax_year=
 *
 * The 5-sheet Excel (P&L + Balance Sheet) the client checks before
 * confirming (Slice 8). Same generator as the staff tool. OWNER-ONLY.
 */

import { createClient } from '@/lib/supabase/server'
import { isAccountOwner } from '@/lib/portal/owner-access'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const url = new URL(request.url)
    const accountId = url.searchParams.get('account_id')
    const taxYear = Number(url.searchParams.get('tax_year'))
    if (!accountId || !Number.isInteger(taxYear)) {
      return NextResponse.json({ error: 'account_id and tax_year required' }, { status: 400 })
    }
    if (!(await isAccountOwner(user, accountId))) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    const { generatePnlExcel } = await import('@/lib/pnl-generator')
    const result = await generatePnlExcel(accountId, taxYear)

    return new NextResponse(new Uint8Array(result.buffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${result.fileName.replace(/[^a-zA-Z0-9._ -]/g, '')}"`,
      },
    })
  } catch (err) {
    console.error('[tax-financials] download failed:', err)
    return NextResponse.json({ error: 'Could not generate the file — please try again.' }, { status: 500 })
  }
}
