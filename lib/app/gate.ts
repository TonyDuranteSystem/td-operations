/**
 * TD Social — the first two steps of EVERY route under /api/marketing/app/ (server; dev job 2072bc3e, Step 2).
 * 1. the on/off switch (OFF = "not switched on" and nothing else was read: this code can be merged before its database files reach production),
 * 2. signed in (the person always comes from the session, never from the request).
 * A route that gets `res` returns it as is; otherwise it has `who`.
 */
import type { NextResponse } from "next/server"
import { isSocialAppEnabled, SOCIAL_APP_NOT_ENABLED } from "@/lib/app/enabled"
import { appJson } from "@/lib/app/http"
import { resolveAppIdentity, type ResolvedAppIdentity } from "@/lib/app/identity"

export async function appGate(): Promise<{ res: NextResponse; who?: undefined } | { who: ResolvedAppIdentity; res?: undefined }> {
  if (!(await isSocialAppEnabled())) return { res: appJson(SOCIAL_APP_NOT_ENABLED, 503) }
  const who = await resolveAppIdentity()
  if (!who) return { res: appJson({ error: "Please sign in.", code: "NOT_SIGNED_IN" }, 401) }
  return { who }
}
