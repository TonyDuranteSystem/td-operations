import { NextRequest } from "next/server"
import { allowedBundleId, currentAppServerEnv } from "@/lib/app/environment"
import { isSocialAppEnabled, SOCIAL_APP_NOT_ENABLED } from "@/lib/app/enabled"
import { parseRegistration, parseRemoval, registerDevice, removeDevice } from "@/lib/app/devices"
import { appJson } from "@/lib/app/http"
import { resolveAppIdentity } from "@/lib/app/identity"
import { tabsFor } from "@/lib/app/tabs"

/**
 * PUT / DELETE /api/marketing/app/devices — TD Social: register or remove THIS person's phone (dev job 2072bc3e, Step 2 pull request A).
 *
 * The person always comes from the session, never from the request. The order is deliberate and each step is tested:
 *   1. the on/off switch (nothing is read while it is off),
 *   2. signed in,
 *   3. (register only) the login has at least one tab: a client, partner or unknown login cannot put a phone in the list,
 *   4. this server knows what it is (its real database address) and the bundle id matches it,
 *   5. the body is valid (a hexadecimal token, a two-value Apple system; an address is never accepted),
 *   6. the write.
 * Removing does NOT require a tab: a person whose tabs were taken away can still remove their own phone.
 */

async function gate() {
  if (!(await isSocialAppEnabled())) return { res: appJson(SOCIAL_APP_NOT_ENABLED, 503) } as const
  const who = await resolveAppIdentity()
  if (!who) return { res: appJson({ error: "Please sign in.", code: "NOT_SIGNED_IN" }, 401) } as const
  return { who } as const
}

const UNKNOWN_SERVER = { error: "TD Social cannot tell which server this is.", code: "APP_ENV_UNKNOWN" } as const

export async function PUT(request: NextRequest) {
  const g = await gate()
  if (g.res) return g.res
  if (tabsFor(g.who.identity).length === 0) return appJson({ error: "Your account is not set up for TD Social.", code: "NO_TABS" }, 403)
  const bundle = allowedBundleId(currentAppServerEnv())
  if (!bundle) return appJson(UNKNOWN_SERVER, 503)
  const parsed = parseRegistration(await request.json().catch(() => null), bundle)
  if (parsed.ok === false) return appJson({ error: parsed.error, code: parsed.code }, 400)
  const r = await registerDevice(g.who.user.id, parsed.value)
  if (r.ok === false) {
    return r.code === "TOO_MANY_DEVICES"
      ? appJson({ error: "This login already has the most phones allowed. Remove one first.", code: r.code }, 409)
      : appJson({ error: "Could not save this phone. Please try again.", code: r.code }, 500)
  }
  return appJson({ ok: true })
}

export async function DELETE(request: NextRequest) {
  const g = await gate()
  if (g.res) return g.res
  const bundle = allowedBundleId(currentAppServerEnv())
  if (!bundle) return appJson(UNKNOWN_SERVER, 503)
  const parsed = parseRemoval(await request.json().catch(() => null), bundle)
  if (parsed.ok === false) return appJson({ error: parsed.error, code: parsed.code }, 400)
  const r = await removeDevice(g.who.user.id, parsed.value.token, parsed.value.bundleId)
  if (r.ok === false) return appJson({ error: "Could not remove this phone. Please try again.", code: r.code }, 500)
  return appJson({ ok: true, removed: r.removed })
}
