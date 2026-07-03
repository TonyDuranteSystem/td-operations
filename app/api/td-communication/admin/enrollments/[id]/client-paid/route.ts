import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { ensureAdmin } from '@/lib/td-communication/admin-auth'
import { markClientPaidOverride } from '@/lib/td-communication/revenue-queries'

export const dynamic = 'force-dynamic'

/**
 * POST /api/td-communication/admin/enrollments/[id]/client-paid — admin marks the
 * client as having paid off-platform (an alternative availability gate to a Paid
 * invoice, for branding collected outside the portal). Admin-only.
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
    await markClientPaidOverride(params.id, user?.email || 'crm-admin')
    return NextResponse.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to mark client paid.'
    return NextResponse.json({ error: message }, { status: message === 'Project not found.' ? 404 : 500 })
  }
}
