import { createClient } from '@/lib/supabase/server'
import { isOwnerOnly } from '@/lib/auth'
import { NextResponse } from 'next/server'
import { insertOwnerTransactionRows, type OwnerImportRow } from '@/lib/owner-transactions-import'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isOwnerOnly(user)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json()
  const rows: OwnerImportRow[] = body.rows

  try {
    const result = await insertOwnerTransactionRows(rows)
    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Import failed'
    const status = message === 'rows must be a non-empty array' || message.startsWith('Row ') ? 400 : 500
    return NextResponse.json({ error: message }, { status })
  }
}
