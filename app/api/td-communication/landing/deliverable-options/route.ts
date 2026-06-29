import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveLandingAccess } from '@/lib/td-communication/admin-auth'
import { listReleasedImageDeliverables } from '@/lib/td-communication/deliverables-queries'

export const dynamic = 'force-dynamic'

/**
 * GET /api/td-communication/landing/deliverable-options — released image
 * deliverables (with signed preview URLs) for the editor's "Add from
 * deliverables" picker. Editor-gated (admin staff or scoped partner) — these
 * are private work files, so this is NEVER public even though the path matches
 * the public landing prefix (the handler enforces auth).
 */
export async function GET(): Promise<NextResponse> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const access = await resolveLandingAccess(user)
  if (!access) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const rows = await listReleasedImageDeliverables()
    const options = rows
      .filter((d) => d.preview_url)
      .map((d) => ({ id: d.id, file_name: d.file_name, preview_url: d.preview_url }))
    return NextResponse.json({ options })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load deliverables.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
