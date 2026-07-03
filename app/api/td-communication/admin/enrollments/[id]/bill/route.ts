import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { ensureAdmin } from '@/lib/td-communication/admin-auth'
import { billClient } from '@/lib/td-communication/revenue-queries'

export const dynamic = 'force-dynamic'

/**
 * POST /api/td-communication/admin/enrollments/[id]/bill — create/link the client
 * invoice (a TD invoice in the main receivables ledger; skip_credit_netting so it
 * only reaches Paid on a real payment). Admin-only. Idempotent.
 */
export async function POST(
  _req: Request,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const gate = ensureAdmin(user)
  if (gate) return gate

  try {
    const result = await billClient(params.id)
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to bill client.'
    return NextResponse.json({ error: message }, { status: message === 'Project not found.' ? 404 : 400 })
  }
}
