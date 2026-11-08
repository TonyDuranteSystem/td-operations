import { NextRequest } from 'next/server'
import { appJson } from '@/lib/app/http'
import { assembleAppMe } from '@/lib/portal-app/assemble'
import { clearBarPref, setBarPref } from '@/lib/portal-app/bar-pref'
import { mergeBarChoice, validateBar } from '@/lib/portal-app/bar'
import { clientAppGate, selectionReader } from '@/lib/portal-app/gate'
import { loadAppMeInput } from '@/lib/portal-app/load'

export const dynamic = 'force-dynamic'

const SERVER_ERROR = { error: 'Something went wrong. Please try again.', code: 'SERVER_ERROR' } as const

/**
 * PUT / DELETE /api/portal/app/bar — the client iPhone app: save, or put back, THIS person's bottom bar (dev job 056a70d0, Step 2).
 *
 * PUT { keys: ["nav.overview", "nav.chat", …] } saves the choice with the login (so it follows them to a new phone). The server never
 * trusts the app: the list is checked against what this person can open RIGHT NOW in the company named in the address (`?account=` …,
 * see `selectionReader`): Chat must stay, at most five, no duplicates, nothing they do not have, never My Company. Choices the person
 * made earlier for entries THIS company does not have (say TD Billing, saved while another company was open) are kept behind the new
 * ones while there is room, so a save here does not erase the bar they set up elsewhere. DELETE forgets the choice ("Put the standard
 * tabs back"). Both answer with the fresh "who am I" answer, so the app redraws from one source. Order of checks: switch → signed in →
 * client or team member → the list → the write. The person always comes from the session. Staff "view as client" sessions are
 * read-only (the middleware blocks writes there).
 */
export async function PUT(request: NextRequest) {
  const g = await clientAppGate()
  if (g.res) return g.res
  try {
    const loaded = await loadAppMeInput(g.user, selectionReader(request))
    if (loaded.ok === false) return appJson({ error: loaded.error, code: loaded.code }, loaded.status)
    const body = (await request.json().catch(() => null)) as { keys?: unknown } | null
    const available = assembleAppMe(loaded.input).items.map(i => i.key)
    const checked = validateBar(body?.keys, available)
    if (checked.ok === false) return appJson({ error: checked.error, code: checked.code }, 400)
    const toSave = mergeBarChoice(checked.keys, loaded.input.savedBar, available)
    const saved = await setBarPref(g.user.id, toSave)
    if (saved.ok === false) return appJson({ error: 'Could not save your bar. Please try again.', code: 'SAVE_FAILED' }, 500)
    return appJson({ ok: true, ...assembleAppMe({ ...loaded.input, savedBar: toSave }) })
  } catch (e) {
    console.error('[client-app] bar save failed:', e instanceof Error ? e.message : 'unknown')
    return appJson(SERVER_ERROR, 500)
  }
}

export async function DELETE(request: NextRequest) {
  const g = await clientAppGate()
  if (g.res) return g.res
  try {
    const loaded = await loadAppMeInput(g.user, selectionReader(request))
    if (loaded.ok === false) return appJson({ error: loaded.error, code: loaded.code }, loaded.status)
    const cleared = await clearBarPref(g.user.id)
    if (cleared.ok === false) return appJson({ error: 'Could not reset your bar. Please try again.', code: 'SAVE_FAILED' }, 500)
    return appJson({ ok: true, ...assembleAppMe({ ...loaded.input, savedBar: null }) })
  } catch (e) {
    console.error('[client-app] bar reset failed:', e instanceof Error ? e.message : 'unknown')
    return appJson(SERVER_ERROR, 500)
  }
}
