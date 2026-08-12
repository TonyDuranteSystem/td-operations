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
    const failedPath = url.searchParams.get('failed_path')
    if (!accountId || !Number.isInteger(taxYear) || (!sourceFileId && !failedPath)) {
      return NextResponse.json({ error: 'account_id, tax_year and source_file_id (or failed_path) required' }, { status: 400 })
    }
    if (!(await isAccountOwner(user, accountId))) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    // Card 4a39e0fd round 2: clearing a FAILED file (no rows ever landed) is a
    // job-cancel, not a row delete — the failed state otherwise wedges the
    // banner + confirm block + all-clear forever.
    if (!sourceFileId && failedPath) {
      const { clearFailedStatementFile } = await import('@/lib/tax/statement-uploads')
      const cleared = await clearFailedStatementFile(accountId, taxYear, failedPath)
      if (!cleared.ok) return NextResponse.json({ error: cleared.error }, { status: 409 })
      // Clearing a failed file IS a file-set mutation — a standing staff
      // unlock was judged against a set that included this hole (round 3).
      const { resetFinancialsAttestation } = await import('@/lib/tax/attestation')
      await resetFinancialsAttestation(accountId, taxYear, `failed file cleared (${failedPath.split('/').pop()})`)
      return NextResponse.json({ deleted: 0, cleared: cleared.cleared })
    }

    const { deleteStatementRows } = await import('@/lib/tax/statement-uploads')
    const result = await deleteStatementRows(accountId, taxYear, sourceFileId)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 })

    // The data changed — a prior attestation no longer covers it (QA finding).
    const { resetFinancialsAttestation } = await import('@/lib/tax/attestation')
    await resetFinancialsAttestation(accountId, taxYear, `file deleted (${result.deleted} transactions)`)

    return NextResponse.json({ deleted: result.deleted })
  } catch (err) {
    console.error('[tax-financials] delete failed:', err)
    return NextResponse.json({ error: 'Could not delete the file — please try again.' }, { status: 500 })
  }
}
