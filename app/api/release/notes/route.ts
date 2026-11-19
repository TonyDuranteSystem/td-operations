import { NextResponse } from 'next/server'
import { BUNDLED_NOTES } from '@/lib/release/bundled-notes'
import { OWN_RELEASE_ID } from '@/lib/release/own-release'
import { notesForPanel } from '@/lib/release/release-notes'

export const dynamic = 'force-dynamic'

/**
 * GET /api/release/notes?since=<note id> → { version, notes, more } — what the live release changes, for the "See what's new" panel
 * on the update bar (dev job 616dc839).
 *
 * `since` is the newest note the asking page was built with; the answer is every note newer than that, newest first, without the
 * behind-the-scenes ones. The notes are compiled into this deployment, so there is NO database, NO Gmail, nothing to slow down or
 * fail. Asked once when the bar appears — not every minute (that is /api/release, which stays a tiny constant). `version` lets the
 * page confirm it was answered by the release it is announcing. Behind the normal login; never cached.
 */
export async function GET(req: Request) {
  const since = new URL(req.url).searchParams.get('since') ?? ''
  const { notes, more } = notesForPanel(BUNDLED_NOTES, since)
  return NextResponse.json({ version: OWN_RELEASE_ID, notes, more }, { headers: { 'Cache-Control': 'no-store, max-age=0' } })
}
