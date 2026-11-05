import { isSocialAppEnabled, SOCIAL_APP_NOT_ENABLED } from "@/lib/app/enabled"
import { appJson } from "@/lib/app/http"
import { resolveAppIdentity } from "@/lib/app/identity"
import { buildMe } from "@/lib/app/me"

/**
 * GET /api/marketing/app/me — TD Social: who am I and which tabs may I see (dev job 2072bc3e, Step 2 pull request A).
 *
 * ONE address for every kind of login. It sits under /api/marketing/ because that is the only family a marketing login may call
 * (lib/auth/role-door.ts); staff (admin, team) pass the door anywhere, clients and partners are turned away by the middleware before this
 * runs. The tabs come from the server's own facts (lib/app/tabs.ts); nothing the phone sends decides them.
 *
 * ORDER MATTERS: the on/off switch is checked FIRST, before any table is read, so this code is safe to merge before its database file
 * has reached production.
 */
export async function GET() {
  if (!(await isSocialAppEnabled())) return appJson(SOCIAL_APP_NOT_ENABLED, 503)
  const who = await resolveAppIdentity()
  if (!who) return appJson({ error: "Please sign in.", code: "NOT_SIGNED_IN" }, 401)
  return appJson(buildMe(who))
}
