import { NextRequest } from "next/server"
import { appGate } from "@/lib/app/gate"
import { appJson } from "@/lib/app/http"
import { effectivePrefs, parsePrefsPatch } from "@/lib/app/prefs"
import { mergePrefs, readState } from "@/lib/app/state"
import { tabsFor } from "@/lib/app/tabs"

export const dynamic = "force-dynamic"

/**
 * PUT /api/marketing/app/prefs — TD Social: change THIS person's alert switches (dev job 2072bc3e, Step 2 pull request B).
 *
 * Body: { mute?: { "<tab>": true|false }, alerts?: { "whatsapp": bool, "email:<mailbox>": bool } }. A switch is merged KEY BY KEY in one database
 * step (lib/app/state.ts), so two phones can never undo each other's change. Only switches for things this person actually has are accepted.
 * Order: switch -> signed in -> has a tab -> body valid -> write. The person is always the session's.
 */
export async function PUT(request: NextRequest) {
  const g = await appGate()
  if (g.res) return g.res
  const tabs = tabsFor(g.who.identity)
  if (tabs.length === 0) return appJson({ error: "Your account is not set up for TD Social.", code: "NO_TABS" }, 403)
  const parsed = parsePrefsPatch(await request.json().catch(() => null), tabs)
  if (parsed.ok === false) return appJson({ error: parsed.error, code: parsed.code }, 400)
  try {
    await mergePrefs(g.who.user.id, parsed.value)
    return appJson({ ok: true, prefs: effectivePrefs(tabs, await readState(g.who.user.id)) })
  } catch (e) {
    console.error("[social-app] prefs write failed:", e instanceof Error ? e.message : "unknown")
    return appJson({ error: "Could not save your switches. Please try again.", code: "DB_ERROR" }, 500)
  }
}
