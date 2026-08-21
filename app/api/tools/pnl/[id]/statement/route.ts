/**
 * DELETE /api/tools/pnl/[id]/statement?source_file_id= (or ?failed_path=) —
 * remove one uploaded statement from a workspace (STAFF ONLY). Source-keyed
 * cascade against the ISOLATED workspace table; never touches a client's
 * books.
 *
 * failed_path (2026-08-21, live-QA bug-hunter finding): a file that failed
 * ingestion never inserted any pnl_workspace_transactions rows, so it has no
 * source_file_id — the delete-by-source path above could never reach it,
 * which wedged the workspace's hard-stop block PERMANENTLY. Mirrors the
 * client-portal route's same two-path split.
 */

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) return NextResponse.json({ error: 'Access denied' }, { status: 403 })

  const sourceFileId = new URL(request.url).searchParams.get('source_file_id')
  const failedPath = new URL(request.url).searchParams.get('failed_path')
  if (!sourceFileId && !failedPath) {
    return NextResponse.json({ error: 'source_file_id or failed_path is required.' }, { status: 400 })
  }

  try {
    if (!sourceFileId && failedPath) {
      const { clearFailedWorkspaceStatementFile } = await import('@/lib/tax/statement-uploads')
      const cleared = await clearFailedWorkspaceStatementFile(params.id, failedPath)
      if (!cleared.ok) return NextResponse.json({ error: cleared.error }, { status: 409 })
      return NextResponse.json({ ok: true, deleted: 0, cleared: cleared.cleared })
    }

    const { data, error } = await db
      .from('pnl_workspace_transactions')
      .delete()
      .eq('workspace_id', params.id)
      .eq('source_file_id', sourceFileId)
      .select('id')
    if (error) throw new Error(error.message)
    return NextResponse.json({ ok: true, deleted: (data ?? []).length })
  } catch (err) {
    console.error('[tools/pnl] statement delete failed:', err)
    return NextResponse.json({ error: 'Could not delete the statement — please try again.' }, { status: 500 })
  }
}
