import { NextRequest } from 'next/server'
import { allowedClientBundleId, currentAppServerEnv } from '@/lib/app/environment'
import { parseRegistration, parseRemoval, registerDevice, removeDevice } from '@/lib/app/devices'
import { appJson } from '@/lib/app/http'
import { clientAppGate, selectionReader } from '@/lib/portal-app/gate'
import { resolveAppAudience } from '@/lib/portal-app/load'

export const dynamic = 'force-dynamic'

/**
 * PUT / DELETE /api/portal/app/devices — the client iPhone app: register or remove THIS person's phone for alerts (dev job 056a70d0, Step 2).
 *
 * Uses the same saved-phones list as TD Social (one row per bundle id + Apple alert token), with the CLIENT app's own bundle id, so a
 * staff phone and a client phone can never be mixed up and a server accepts only its own id (a sandbox build can never register on
 * production). The person always comes from the session, never from the request. Order (each tested):
 *   1. the on/off switch, 2. signed in, 3. (register only) the login is a client or a team member a client added (staff and partners
 *   are refused), 4. this server knows what it is and the bundle id matches, 5. the body is valid, 6. the write.
 * Removing does NOT require step 3: a person who lost access can still remove their own phone.
 * Alerts to these phones are Step 4 (lib/portal-app/send-to-client-phones.ts); the phone is saved with its owner (contact or company) so an alert can find it.
 */
const UNKNOWN_SERVER = { error: 'The app cannot tell which server this is.', code: 'APP_ENV_UNKNOWN' } as const

export async function PUT(request: NextRequest) {
  const g = await clientAppGate()
  if (g.res) return g.res
  try {
    const audience = await resolveAppAudience(g.user, selectionReader(request))
    if (audience.ok === false) return appJson({ error: audience.error, code: audience.code }, audience.status)
    const bundle = allowedClientBundleId(currentAppServerEnv())
    if (!bundle) return appJson(UNKNOWN_SERVER, 503)
    const parsed = parseRegistration(await request.json().catch(() => null), bundle)
    if (parsed.ok === false) return appJson({ error: parsed.error, code: parsed.code }, 400)
    // who this phone belongs to: a client's contact, or the company of a team member (from the session; used to find the right phones for an alert)
    const owner = audience.kind === 'client' ? { contactId: audience.contactId } : { teamAccountId: audience.account.id }
    const r = await registerDevice(g.user.id, parsed.value, new Date(), owner)
    if (r.ok === false) {
      return r.code === 'TOO_MANY_DEVICES'
        ? appJson({ error: 'This login already has the most phones allowed. Remove one first.', code: r.code }, 409)
        : appJson({ error: 'Could not save this phone. Please try again.', code: r.code }, 500)
    }
    return appJson({ ok: true })
  } catch (e) {
    console.error('[client-app] phone register failed:', e instanceof Error ? e.message : 'unknown')
    return appJson({ error: 'Something went wrong. Please try again.', code: 'SERVER_ERROR' }, 500)
  }
}

export async function DELETE(request: NextRequest) {
  const g = await clientAppGate()
  if (g.res) return g.res
  const bundle = allowedClientBundleId(currentAppServerEnv())
  if (!bundle) return appJson(UNKNOWN_SERVER, 503)
  const parsed = parseRemoval(await request.json().catch(() => null), bundle)
  if (parsed.ok === false) return appJson({ error: parsed.error, code: parsed.code }, 400)
  const r = await removeDevice(g.user.id, parsed.value.token, parsed.value.bundleId)
  if (r.ok === false) return appJson({ error: 'Could not remove this phone. Please try again.', code: r.code }, 500)
  return appJson({ ok: true, removed: r.removed })
}
