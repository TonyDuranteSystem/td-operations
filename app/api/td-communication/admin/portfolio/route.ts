import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolvePortfolioAccess } from '@/lib/td-communication/admin-auth'
import { listPortfolioForCurator, createPortfolioEntry } from '@/lib/td-communication/portfolio-queries'

export const dynamic = 'force-dynamic'

/**
 * GET  /api/td-communication/admin/portfolio — curator list (all non-deleted
 *      entries + resolved consent badge). Admits staff + scoped partner (Cris).
 * POST /api/td-communication/admin/portfolio — create a draft entry (canEdit).
 *
 * Self-authenticates via resolvePortfolioAccess (middleware does NOT guard this
 * prefix for partners — see admin-auth.ts).
 */
export async function GET(): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const access = await resolvePortfolioAccess(user)
  if (!access) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const entries = await listPortfolioForCurator()
    return NextResponse.json({ entries, canEdit: access.canEdit })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not load the portfolio.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const access = await resolvePortfolioAccess(user)
  if (!access) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!access.canEdit) {
    return NextResponse.json({ error: 'You do not have permission to edit the portfolio.' }, { status: 403 })
  }
  const body = await req.json().catch(() => ({}))
  try {
    const entry = await createPortfolioEntry(body, access.participant.name)
    return NextResponse.json({ entry })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not create the entry.'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
