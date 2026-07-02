/**
 * DELETE /api/tools/pnl/[id]/statement?source_file_id= — remove one uploaded
 * statement's rows from a workspace (STAFF ONLY). Source-keyed cascade against
 * the ISOLATED workspace table; never touches a client's books.
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
  if (!sourceFileId) return NextResponse.json({ error: 'source_file_id is required.' }, { status: 400 })

  try {
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
