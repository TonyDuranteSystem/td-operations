/**
 * TD Social — the answer to "what may I see?" (pure; dev job 2072bc3e, Step 2 pull request A).
 * Pull request B adds the person's switches and the icon number to this same answer.
 */
import { loginKind, tabsFor, type AppTab, type LoginKind } from "@/lib/app/tabs"
import type { ResolvedAppIdentity } from "@/lib/app/identity"

export interface AppMe {
  ok: true
  user: { id: string; email: string | null; name: string }
  loginKind: LoginKind
  tabs: AppTab[]
  /** true when the login has no tab: the app shows "Your account is not set up for TD Social" */
  notSetUp: boolean
}

export function buildMe(r: ResolvedAppIdentity): AppMe {
  const tabs = tabsFor(r.identity)
  return { ok: true, user: r.user, loginKind: loginKind(r.identity), tabs, notSetUp: tabs.length === 0 }
}
