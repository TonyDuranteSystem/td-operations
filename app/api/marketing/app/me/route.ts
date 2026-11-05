import { appGate } from "@/lib/app/gate"
import { appJson } from "@/lib/app/http"
import { buildMe } from "@/lib/app/me"

// never cached: the answer is about one person and changes with what is waiting for them
export const dynamic = "force-dynamic"

/**
 * GET /api/marketing/app/me — TD Social: who am I, which tabs may I see, my switches, and what is waiting for me
 * (dev job 2072bc3e, Step 2 pull requests A and B).
 *
 * ONE address for every kind of login. It sits under /api/marketing/ because that is the only family a marketing login may call
 * (lib/auth/role-door.ts); staff (admin, team) pass the door anywhere, clients and partners are turned away by the middleware before this
 * runs. The tabs come from the server's own facts (lib/app/tabs.ts); nothing the phone sends decides them.
 *
 * ORDER MATTERS: appGate() checks the on/off switch FIRST, before any table is read, so this code is safe to merge before its database
 * files have reached production.
 */
export async function GET() {
  const g = await appGate()
  if (g.res) return g.res
  return appJson(await buildMe(g.who))
}
