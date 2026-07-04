import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolvePortfolioAccess } from '@/lib/td-communication/admin-auth'
import { updatePortfolioEntry, softDeletePortfolioEntry } from '@/lib/td-communication/portfolio-queries'

export const dynamic = 'force-dynamic'

/**
 * PATCH  /api/td-communication/admin/portfolio/[id] — edit an entry's content
 *        (title/description/images/tags/category/consent-source). canEdit.
 * DELETE /api/td-communication/admin/portfolio/[id] — soft-delete (R100) + remove
 *        the copied public images. canEdit.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const access = await resolvePortfolioAccess(user)
  if (!access) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!access.canEdit) {
    return NextResponse.json({ error: 'You do not have permission to edit the portfolio.' }, { status: 403 })
  }
  const body = await req.json().catch(() => ({}))
  try {
    const entry = await updatePortfolioEntry(params.id, body)
    return NextResponse.json({ entry })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not update the entry.'
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const access = await resolvePortfolioAccess(user)
  if (!access) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!access.canEdit) {
    return NextResponse.json({ error: 'You do not have permission to edit the portfolio.' }, { status: 403 })
  }
  try {
    await softDeletePortfolioEntry(params.id, access.participant.name)
    return NextResponse.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not delete the entry.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
