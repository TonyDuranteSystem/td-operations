/**
 * "Staff reply = read" — WhatsApp semantics for the CRM Portal Chats inbox.
 *
 * When staff sends a reply, they have, by definition, seen everything the
 * client said in that conversation up to now — so the staff unread (red) dot
 * for that conversation must clear. Historically this only happened in the
 * browser (the dashboard POSTed /chat/read on send success), which:
 *   - missed on MULTI-MEMBER companies (the contact-scoped read deliberately
 *     excludes account-owned threads), leaving the client's message flagged
 *     even after staff answered; and
 *   - never ran at all when the reply came from another surface (mobile edge
 *     cases, the Inbox, the AI/MCP send tool).
 *
 * Moving it server-side into the reply WRITE itself makes it fire every time,
 * on every surface. The read scope mirrors the thread the reply lands in —
 * identical to POST /api/portal/chat/read for a staff (dashboard) caller, minus
 * the topic filter (a reply means the whole conversation was seen, so all
 * topics clear — this also fixes named-topic messages that used to linger).
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { multiMemberAccountIds } from "@/lib/portal/thread-scope"

/** One UPDATE the executor must run to clear the client's unread in a thread. */
export type StaffReplyReadStep =
  | { kind: "account"; account_id: string }
  | { kind: "contact_tagged"; contact_id: string; excludeAccountIds: string[] }
  | { kind: "company_only"; accountIds: string[] }

/**
 * PURE. Decide which client messages a staff reply clears, from the reply's
 * landing ids + the caller-resolved account graph. No DB access — unit tested.
 *
 * Rules:
 *  - account_id present ⇒ the company/account thread. Clear EVERY client message
 *    on that account (solo OR multi-member: replying in the company thread means
 *    you've read the company thread). Personal-NULL DMs are left untouched — a
 *    company reply doesn't clear a person's separate DM thread.
 *  - account_id absent, contact_id present ⇒ the person thread. Clear the
 *    contact's own messages (excluding any that live on a multi-member account,
 *    which owns its own thread) PLUS company-only legacy rows on the contact's
 *    NON-multi-member linked accounts.
 *  - neither id ⇒ nothing to do.
 */
export function buildStaffReplyReadPlan(params: {
  account_id: string | null
  contact_id: string | null
  linkedAccountIds: string[]
  multiMemberAccountIds: string[]
}): StaffReplyReadStep[] {
  const { account_id, contact_id, linkedAccountIds, multiMemberAccountIds: mm } = params

  if (account_id) return [{ kind: "account", account_id }]
  if (!contact_id) return []

  const excludedSet = new Set(mm)
  const steps: StaffReplyReadStep[] = [
    { kind: "contact_tagged", contact_id, excludeAccountIds: mm },
  ]
  const companyOnly = linkedAccountIds.filter((id) => !excludedSet.has(id))
  if (companyOnly.length > 0) steps.push({ kind: "company_only", accountIds: companyOnly })
  return steps
}

/**
 * Execute the plan for a staff reply. Best-effort: marks the client's unread
 * messages in the reply's thread as read. Never touches rows the client
 * explicitly kept unread. Returns the number of rows marked (cosmetic).
 */
export async function markClientMessagesReadForStaffReply(params: {
  account_id: string | null
  contact_id: string | null
}): Promise<number> {
  const { account_id, contact_id } = params
  if (!account_id && !contact_id) return 0

  let linkedAccountIds: string[] = []
  let mm: string[] = []
  if (!account_id && contact_id) {
    const { data: acRows } = await supabaseAdmin
      .from("account_contacts")
      .select("account_id")
      .eq("contact_id", contact_id)
    linkedAccountIds = (acRows ?? []).map((r) => r.account_id as string)
    mm = await multiMemberAccountIds(linkedAccountIds)
  }

  const plan = buildStaffReplyReadPlan({
    account_id,
    contact_id,
    linkedAccountIds,
    multiMemberAccountIds: mm,
  })

  const now = new Date().toISOString()
  let marked = 0

  // Staff replies also clear plain system notices (out-of-office autoreply and
  // similar) alongside the client's own messages — otherwise a conversation
  // that ever got one stays permanently "unread" no matter how many times
  // staff replies (2026-08-27). Chat-event marker rows are EXCLUDED: those are
  // acknowledged via their own handled_at flag (What's New panel), never via
  // read_at — see lib/portal/chat-events.ts.
  const NOT_CHAT_EVENT = '%<!-- chat-event:%'

  for (const step of plan) {
    if (step.kind === "account") {
      let q = supabaseAdmin
        .from("portal_messages")
        .update({ read_at: now })
        .eq("account_id", step.account_id)
        .in("sender_type", ["client", "system"])
        .not("message", "ilike", NOT_CHAT_EVENT)
        .is("read_at", null)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- client_kept_unread predates generated types
      q = (q as any).eq("client_kept_unread", false)
      const { count } = await q
      marked += count ?? 0
    } else if (step.kind === "contact_tagged") {
      let q = supabaseAdmin
        .from("portal_messages")
        .update({ read_at: now })
        .eq("contact_id", step.contact_id)
        .in("sender_type", ["client", "system"])
        .not("message", "ilike", NOT_CHAT_EVENT)
        .is("read_at", null)
      if (step.excludeAccountIds.length > 0) {
        q = q.or(`account_id.is.null,account_id.not.in.(${step.excludeAccountIds.join(",")})`)
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- client_kept_unread predates generated types
      q = (q as any).eq("client_kept_unread", false)
      const { count } = await q
      marked += count ?? 0
    } else {
      let q = supabaseAdmin
        .from("portal_messages")
        .update({ read_at: now })
        .is("contact_id", null)
        .in("account_id", step.accountIds)
        .in("sender_type", ["client", "system"])
        .not("message", "ilike", NOT_CHAT_EVENT)
        .is("read_at", null)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- client_kept_unread predates generated types
      q = (q as any).eq("client_kept_unread", false)
      const { count } = await q
      marked += count ?? 0
    }
  }

  return marked
}
