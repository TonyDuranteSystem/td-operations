/**
 * DELETE /api/portal/tax-financials/statement?account_id=&tax_year=&source_file_id=
 *
 * Delete & replace (master plan §6): removes exactly the transactions that
 * came from one uploaded file (source-keyed cascade). The draft is computed
 * on demand, so the numbers update on the next load. Refused after the
 * client confirmed (post-confirm lock) — staff must reopen first.
 *
 * OWNER-ONLY.
 */

import { createClient } from '@/lib/supabase/server'
import { isAccountOwner } from '@/lib/portal/owner-access'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function DELETE(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const url = new URL(request.url)
    const accountId = url.searchParams.get('account_id')
    const taxYear = Number(url.searchParams.get('tax_year'))
    const sourceFileId = url.searchParams.get('source_file_id')
    if (!accountId || !Number.isInteger(taxYear) || !sourceFileId) {
      return NextResponse.json({ error: 'account_id, tax_year and source_file_id required' }, { status: 400 })
    }
    if (!(await isAccountOwner(user, accountId))) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    const { deleteStatementRows } = await import('@/lib/tax/statement-uploads')
    const result = await deleteStatementRows(accountId, taxYear, sourceFileId)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 })
    return NextResponse.json({ deleted: result.deleted })
  } catch (err) {
    console.error('[tax-financials] delete failed:', err)
    return NextResponse.json({ error: 'Could not delete the file — please try again.' }, { status: 500 })
  }
}
