import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { parseLayout, MAX_LAYOUT_BYTES } from '@/lib/nav/menu-layout'
import { getStaffMenuLayout, resetStaffMenuLayout, saveStaffMenuLayout } from '@/lib/nav/menu-layout-server'

export const dynamic = 'force-dynamic'

/**
 * The signed-in staff member's own left-menu layout (dev job 45aa5872). Each person can only ever touch THEIR row — the user id
 * comes from the session, never from the request. The layout is shape-checked here (lib/nav/menu-layout.ts); which pages exist
 * and who may see them is decided in the browser from code, so a stored layout can't unlock a page.
 */
async function staffUserId(): Promise<string | null> {
  try {
    const { data: { user } } = await createClient().auth.getUser()
    return user && isDashboardUser(user) ? user.id : null
  } catch {
    return null
  }
}

/** The caller's saved layout, for a tab that has been open a while (it re-reads when you come back to it). */
export async function GET() {
  const userId = await staffUserId()
  if (!userId) return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
  const read = await getStaffMenuLayout(userId)
  return NextResponse.json(read, { headers: { 'Cache-Control': 'no-store' } })
}

export async function PUT(request: Request) {
  const userId = await staffUserId()
  if (!userId) return NextResponse.json({ error: 'Not authorized' }, { status: 403 })

  const text = await request.text().catch(() => '')
  if (text.length > MAX_LAYOUT_BYTES + 512) return NextResponse.json({ error: 'That menu layout is too big to save.' }, { status: 413 })
  let body: unknown
  try { body = JSON.parse(text) } catch { return NextResponse.json({ error: 'That menu layout could not be read.' }, { status: 400 }) }

  const layout = parseLayout((body as { layout?: unknown } | null)?.layout)
  if (!layout) return NextResponse.json({ error: 'That menu layout is not valid, so it was not saved.' }, { status: 400 })

  const saved = await saveStaffMenuLayout(userId, layout)
  if (!saved.ok) return NextResponse.json({ error: saved.error ?? 'Could not save your menu.' }, { status: 500 })
  return NextResponse.json({ ok: true })
}

/** Reset to the standard layout: forget the saved one. */
export async function DELETE() {
  const userId = await staffUserId()
  if (!userId) return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
  const done = await resetStaffMenuLayout(userId)
  if (!done.ok) return NextResponse.json({ error: done.error ?? 'Could not reset your menu.' }, { status: 500 })
  return NextResponse.json({ ok: true })
}
