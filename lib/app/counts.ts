/**
 * TD Social — what is waiting for this person, per tab, and the number on the app icon
 * (server; dev job 2072bc3e, Step 2 pull request B; Council-reviewed plan of 5 Nov 2026).
 *
 * These are NEW helpers. The CRM's own red numbers (app/api/dashboard/badges, app/api/inbox/stats) are NOT touched: staff read them every day and
 * the plan keeps them exactly as they are. Where the CRM's number is wrong the app does the right thing and the difference is reported, not hidden:
 *   - Portal: the CRM caps the list at 500 and counts messages a staff member deleted; the app counts exactly and skips deleted ones (R100).
 *   - Email: the CRM shows ALL unread in the Gmail Inbox; the app counts only NEW mail since the person last opened that mailbox (their approved
 *     choice), from the CRM's own stored copy (no live Gmail call): in the Inbox, unread, not from our own addresses, not spam / trash / draft.
 *     The first time there is no baseline: it is set to "now" and the count is 0, so the number starts clean.
 *
 * The number is honest or absent. A muted tab is not counted. If ANY counted tab fails or is too slow, `badge` is null: the alert then goes without a
 * number and the phone keeps the one it has (a failed count must never become 0 and wipe a good number).
 */
import { createClient } from "@supabase/supabase-js"
import { countTalkNotifications, type TeamThreadCountRow } from "@/lib/team/workspace"
import { OWN_MAILBOX_ADDRESSES } from "@/lib/gmail"
import { marketingChatUnread } from "@/lib/marketing/menu-unread"
import type { MarketingContext } from "@/lib/marketing/guard"
import { markInboxOpened } from "@/lib/app/state"
import type { AppTab } from "@/lib/app/tabs"

/** Most time the whole count may take before the number is left out. */
export const COUNT_TIMEOUT_MS = 1500

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- newer tables and functions than the generated types
export interface CountDb { from: (t: string) => any; rpc: (fn: string, args: Record<string, unknown>) => any }

/** Fresh client per call, like the CRM's own badge route (no stale cached connection behind a number people watch). */
function freshDb(): CountDb {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!) as unknown as CountDb
}

export async function countTalk(db: CountDb, userId: string): Promise<number> {
  const { data, error } = await db.rpc("get_team_threads", { p_user_id: userId })
  if (error) throw new Error("talk count failed")
  return countTalkNotifications((data ?? []) as TeamThreadCountRow[])
}

/** Unread client messages, exactly (no cap), skipping deleted ones. Shared by all staff: a client message is read once for everyone. */
export async function countPortal(db: CountDb): Promise<number> {
  const { count, error } = await db.from("portal_messages").select("id", { count: "exact", head: true })
    .eq("sender_type", "client").is("read_at", null).is("deleted_at", null)
  if (error) throw new Error("portal count failed")
  return count ?? 0
}

/** Same definition as the CRM menu's WhatsApp number: unread messages in the active WhatsApp chats (Telegram is not WhatsApp). */
export async function countWhatsapp(db: CountDb): Promise<number> {
  const ch = await db.from("messaging_channels").select("id").eq("platform", "whatsapp")
  if (ch.error) throw new Error("whatsapp channels failed")
  const ids = ((ch.data ?? []) as Array<{ id: string }>).map(c => c.id)
  if (ids.length === 0) return 0
  const g = await db.from("messaging_groups").select("unread_count").eq("is_active", true).gt("unread_count", 0).in("channel_id", ids)
  if (g.error) throw new Error("whatsapp count failed")
  return ((g.data ?? []) as Array<{ unread_count: number | null }>).reduce((s, r) => s + (r.unread_count ?? 0), 0)
}

function validTime(v: unknown): string | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null
}

/** New mail since the person last opened each mailbox they may open. */
export async function countNewEmail(
  db: CountDb, userId: string, mailboxes: readonly string[], opened: Record<string, unknown>, now: Date,
  setBaseline: (userId: string, mailbox: string, at: Date, onlyIfMissing: boolean) => Promise<unknown> = markInboxOpened,
): Promise<number> {
  let total = 0
  for (const mailbox of mailboxes) {
    const since = validTime(opened[mailbox])
    if (!since) { await setBaseline(userId, mailbox, now, true); continue } // first time: start clean
    const { count, error } = await db.from("email_index").select("id", { count: "exact", head: true })
      .eq("mailbox", mailbox).eq("is_unread", true).contains("label_ids", ["INBOX"])
      .not("label_ids", "cs", "{SPAM}").not("label_ids", "cs", "{TRASH}").not("label_ids", "cs", "{DRAFT}")
      .gt("internal_date", since)
      .or(`from_email.is.null,from_email.not.in.(${OWN_MAILBOX_ADDRESSES.join(",")})`)
    if (error) throw new Error("email count failed")
    total += count ?? 0
  }
  return total
}

export type TabCounts = Record<string, number | null>

export interface CountInput {
  userId: string
  tabs: readonly AppTab[]
  mutedTabs: readonly string[]
  /** stored "last opened" times by mailbox */
  inboxOpened: Record<string, unknown>
  /** the person's Marketing context, when they have a Marketing tab */
  marketing?: Pick<MarketingContext, "permissions" | "team" | "user" | "role" | "membership">
  now?: Date
  db?: CountDb
  timeoutMs?: number
}

function withCap<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>(resolve => {
    const timer = setTimeout(() => resolve(null), ms)
    work.then(v => { clearTimeout(timer); resolve(v) }, () => { clearTimeout(timer); resolve(null) })
  })
}

/**
 * The count of every NOT-muted tab, in parallel, each under the same cap. null = could not be counted (failure or too slow).
 * `badge` is the sum of the counted tabs, or null if any of them is null.
 */
export async function countTabs(input: CountInput): Promise<{ counts: TabCounts; badge: number | null }> {
  const db = input.db ?? freshDb()
  const now = input.now ?? new Date()
  const cap = input.timeoutMs ?? COUNT_TIMEOUT_MS
  const muted = new Set(input.mutedTabs)
  const live = input.tabs.filter(t => !muted.has(t.id))
  const work: Record<string, () => Promise<number>> = {
    talk: () => countTalk(db, input.userId),
    portal: () => countPortal(db),
    whatsapp: () => countWhatsapp(db),
    inbox: () => {
      const inbox = input.tabs.find(t => t.id === "inbox")
      return countNewEmail(db, input.userId, inbox?.mailboxes ?? [], input.inboxOpened, now)
    },
    marketing: () => (input.marketing ? marketingChatUnread(input.marketing) : Promise.reject(new Error("no marketing context"))),
  }
  const entries = await Promise.all(live.map(async t => {
    const fn = work[t.id]
    // a tab this file does not know how to count cannot be added into a number honestly: it makes the whole number absent
    return [t.id, fn ? await withCap(fn(), cap) : null] as const
  }))
  const counts: TabCounts = Object.fromEntries(entries)
  const values = Object.values(counts)
  const badge = values.some(v => v === null) ? null : values.reduce<number>((s, v) => s + (v ?? 0), 0)
  return { counts, badge }
}
