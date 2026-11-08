import { NextRequest } from 'next/server'
import { appJson } from '@/lib/app/http'
import { assembleAppMe } from '@/lib/portal-app/assemble'
import { clientAppGate, selectionReader } from '@/lib/portal-app/gate'
import { loadAppMeInput } from '@/lib/portal-app/load'

export const dynamic = 'force-dynamic'

/**
 * GET /api/portal/app/me — the client iPhone app: "who am I and what can I open" (dev job 056a70d0, Step 2).
 *
 * Answers, for the signed-in client (or the team member a client added): every menu entry they can open in the portal's own order with
 * its words and link in their language and the number waiting in it, their bottom bar (their choice, or the standard one), the number
 * for the round Menu button, and whether the Pay button is on. It uses the same menu rule as the website. Order of checks (each tested):
 * on/off switch → signed in → client or team member (staff and partners are refused) → the answer. Every answer is `no-store`.
 * Which company: `?account=<id>` (or `?formation=` / `?onboarding=`, and `?mode=`) — see `selectionReader` in the gate; the website's
 * cookies never reach this path. Without them the first company answers, exactly like the website.
 */
export async function GET(request: NextRequest) {
  const g = await clientAppGate()
  if (g.res) return g.res
  try {
    const loaded = await loadAppMeInput(g.user, selectionReader(request))
    if (loaded.ok === false) return appJson({ error: loaded.error, code: loaded.code }, loaded.status)
    return appJson({ ok: true, ...assembleAppMe(loaded.input) })
  } catch (e) {
    console.error('[client-app] me failed:', e instanceof Error ? e.message : 'unknown')
    return appJson({ error: 'Something went wrong. Please try again.', code: 'SERVER_ERROR' }, 500)
  }
}
