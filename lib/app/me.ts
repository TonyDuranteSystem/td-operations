/**
 * TD Social — the answer to "what may I see, and what is waiting for me?" (server; dev job 2072bc3e, Step 2 pull requests A and B).
 *
 * A: who, which tabs. B adds the person's switches, the count per tab and the icon number. Failures degrade, never lie:
 *  - the switches cannot be read -> the rule defaults, and no count (the email baseline needs the stored times, so an honest count is impossible);
 *  - a tab cannot be counted -> that tab's count is null and `badge` is null (the app keeps the number it has).
 */
import { loginKind, tabsFor, type AppTab, type LoginKind } from "@/lib/app/tabs"
import type { ResolvedAppIdentity } from "@/lib/app/identity"
import { effectivePrefs, type EffectivePrefs } from "@/lib/app/prefs"
import { readState, type StoredState } from "@/lib/app/state"
import { countTabs, type TabCounts } from "@/lib/app/counts"

export interface AppMe {
  ok: true
  user: { id: string; email: string | null; name: string }
  loginKind: LoginKind
  tabs: AppTab[]
  /** true when the login has no tab: the app shows "Your account is not set up for TD Social" */
  notSetUp: boolean
  prefs: EffectivePrefs
  /** unread per not-muted tab; a value is null when that tab could not be counted; null as a whole when nothing could be counted */
  counts: TabCounts | null
  /** the number for the app icon: the sum of the not-muted tabs, or null when any of them could not be counted */
  badge: number | null
}

export async function buildMe(r: ResolvedAppIdentity, now: Date = new Date()): Promise<AppMe> {
  const tabs = tabsFor(r.identity)
  const base = { ok: true as const, user: r.user, loginKind: loginKind(r.identity), tabs, notSetUp: tabs.length === 0 }
  if (tabs.length === 0) return { ...base, prefs: effectivePrefs([], null), counts: {}, badge: 0 }

  let state: StoredState | null = null
  try {
    state = await readState(r.user.id)
  } catch (e) {
    console.error("[social-app] switches unreadable:", e instanceof Error ? e.message : "unknown")
    return { ...base, prefs: effectivePrefs(tabs, null), counts: null, badge: null }
  }
  const prefs = effectivePrefs(tabs, state)
  const { counts, badge } = await countTabs({
    userId: r.user.id,
    tabs,
    mutedTabs: prefs.mutedTabs,
    inboxOpened: state?.inbox_opened && typeof state.inbox_opened === "object" ? state.inbox_opened : {},
    marketing: r.marketing,
    now,
  })
  return { ...base, prefs, counts, badge }
}
