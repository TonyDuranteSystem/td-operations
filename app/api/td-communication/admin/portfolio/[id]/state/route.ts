import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { ensureAdmin } from '@/lib/td-communication/admin-auth'
import { setPortfolioPublished, setPortfolioFeatured } from '@/lib/td-communication/portfolio-queries'

export const dynamic = 'force-dynamic'

/**
 * POST /api/td-communication/admin/portfolio/[id]/state — publish/unpublish and/or
 * feature an entry. ADMIN-ONLY: these change what the public sees, so they are
 * gated tighter than create/edit (which a partner may do). Body: { published?, featured? }.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const gate = ensureAdmin(user)
  if (gate) return gate

  const body = await req.json().catch(() => ({}))
  try {
    let entry
    if (typeof body.published === 'boolean') {
      entry = await setPortfolioPublished(params.id, body.published)
    }
    if (typeof body.featured === 'boolean') {
      entry = await setPortfolioFeatured(params.id, body.featured)
    }
    if (!entry) {
      return NextResponse.json({ error: 'Nothing to change (send published and/or featured).' }, { status: 400 })
    }
    return NextResponse.json({ entry })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not update the entry.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
