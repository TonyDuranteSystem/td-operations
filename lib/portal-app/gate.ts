/**
 * Client iPhone app — the first two steps of EVERY route under /api/portal/app/ (server; dev job 056a70d0, Step 2).
 * 1. the on/off switch (OFF = "not switched on" and nothing else was read: this code can be merged long before the app exists),
 * 2. signed in (the person always comes from the session, never from the request).
 * Who the person is FOR the app (client / team member / refused) is decided next by `resolveAppAudience` in ./load.ts.
 *
 * WARNING (lib/auth/client-api-allowlist.ts): /api/portal/ is open to client logins by design, and it also holds staff routes. Every route
 * in this folder goes through this gate AND then through resolveAppAudience, so a staff or partner login gets a plain refusal.
 */
import type { NextResponse } from 'next/server'
import type { User } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { appJson } from '@/lib/app/http'
import { CLIENT_APP_NOT_ENABLED, isClientAppEnabled } from '@/lib/portal-app/enabled'

export async function clientAppGate(): Promise<{ res: NextResponse; user?: undefined } | { user: User; res?: undefined }> {
  if (!(await isClientAppEnabled())) return { res: appJson(CLIENT_APP_NOT_ENABLED, 503) }
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { res: appJson({ error: 'Please sign in.', code: 'NOT_SIGNED_IN' }, 401) }
  return { user }
}

/**
 * Which company (or company being formed / set up) and which Client / Partner mode the app is asking about.
 *
 * The website remembers these in cookies (`portal_account_id`, `portal_formation`, `portal_onboarding`, `portal_mode`), but the company
 * switcher writes them for the path `/portal` only, so a browser never sends them to `/api/portal/app/…`. The app therefore says it
 * explicitly in the address: `?account=<id>`, `?formation=<id>`, `?onboarding=<id>`, `?mode=client|partner`. This returns a reader with
 * the same shape the loader already uses for the cookies (it is asked for the cookie names and answers from the address). Whatever is
 * named still goes through `resolveSelectedEntity`, which only honours companies this person owns, so a made-up id is ignored.
 */
export const SELECTION_PARAMS: Readonly<Record<string, string>> = {
  portal_account_id: 'account',
  portal_formation: 'formation',
  portal_onboarding: 'onboarding',
  portal_mode: 'mode',
}

export function selectionReader(request: { url: string }): (name: string) => string | undefined {
  let params: URLSearchParams
  try {
    params = new URL(request.url).searchParams
  } catch {
    params = new URLSearchParams()
  }
  return name => {
    const key = SELECTION_PARAMS[name]
    const v = key ? params.get(key) : null
    // Short, plain values only: an id or a mode word. Anything else is treated as "not said".
    return v && v.length <= 80 ? v : undefined
  }
}
