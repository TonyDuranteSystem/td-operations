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
 * identical to POST /api/portal/chat/read for a staff (dashboard) caller,
 * INCLUDING the topic filter: a reply only clears the topic it was sent in,
 * never the whole conversation (2026-08-30 — a reply used to clear every
 * topic at once, silently marking unrelated unread topics as seen the moment
 * staff answered something else; caught via 18 confirmed production cases).
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
 * Resolve the SAME thread scope `markClientMessagesReadForStaffReply` uses,
 * from just account_id/contact_id. Shared so the read-clear and the
 * fallback-topic lookup below can never disagree about "which thread is
 * this reply landing in" (they used to be two separate ad-hoc queries).
 */
async function resolveThreadScopePlan(
  account_id: string | null,
  contact_id: string | null,
): Promise<StaffReplyReadStep[]> {
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
  return buildStaffReplyReadPlan({
    account_id,
    contact_id,
    linkedAccountIds,
    multiMemberAccountIds: mm,
  })
}

/**
 * Fallback topic for a reply that wasn't told which topic it belongs to
 * (2026-09-23 — the MCP send tool and the AI worker's send tool gained an
 * optional `topic` param so the AI can pass back the exact tag it saw on
 * `search_portal_messages`; this is the safety net for when it doesn't,
 * e.g. a proactive staff-initiated message with nothing to reply to).
 *
 * Returns the topic of the most recent CLIENT-sent message in the SAME
 * thread scope a reply here would land in (reusing
 * `buildStaffReplyReadPlan` so this can't disagree with the read-clear about
 * which thread that is — see `resolveThreadScopePlan`). System/auto-reply
 * rows are excluded: they don't represent a client's own topic choice.
 * Returns null (General) when there's no prior client message to inherit
 * from, which matches today's existing default for a fresh/proactive thread.
 */
export async function resolveFallbackReplyTopic(params: {
  account_id: string | null
  contact_id: string | null
}): Promise<string | null> {
  const { account_id, contact_id } = params
  if (!account_id && !contact_id) return null

  const plan = await resolveThreadScopePlan(account_id, contact_id)
  if (plan.length === 0) return null

  const candidates: Array<{ topic: string | null; created_at: string } | null> = []
  for (const step of plan) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- chained Supabase query builder, shape varies per branch below
    let q: any = supabaseAdmin
      .from("portal_messages")
      .select("topic, created_at")
      .eq("sender_type", "client")
      .order("created_at", { ascending: false })
      .limit(1)

    if (step.kind === "account") {
      q = q.eq("account_id", step.account_id)
    } else if (step.kind === "contact_tagged") {
      q = q.eq("contact_id", step.contact_id)
      if (step.excludeAccountIds.length > 0) {
        q = q.or(`account_id.is.null,account_id.not.in.(${step.excludeAccountIds.join(",")})`)
      }
    } else {
      q = q.is("contact_id", null).in("account_id", step.accountIds)
    }

    const { data } = await q.maybeSingle()
    candidates.push(data ? { topic: data.topic ?? null, created_at: data.created_at } : null)
  }

  return pickLatestTopic(candidates)
}

/**
 * PURE. Given one "most recent client message" candidate per thread-scope
 * step (null where a step found none), return the topic of whichever
 * candidate is actually most recent. Split out from
 * `resolveFallbackReplyTopic` so this pick logic is unit-testable without a
 * database — the multi-step case (a person thread with a company-only arm)
 * is exactly where a naive "first non-null wins" would pick a stale topic
 * over a fresher one from the other arm.
 */
export function pickLatestTopic(
  candidates: Array<{ topic: string | null; created_at: string } | null>,
): string | null {
  let best: { topic: string | null; created_at: string } | null = null
  for (const c of candidates) {
    if (c && (!best || c.created_at > best.created_at)) best = c
  }
  return best?.topic ?? null
}

/**
 * Execute the plan for a staff reply. Best-effort: marks the client's unread
 * messages in the reply's thread as read. Never touches rows the client
 * explicitly kept unread. Returns the number of rows marked (cosmetic).
 */
export async function markClientMessagesReadForStaffReply(params: {
  account_id: string | null
  contact_id: string | null
  /**
   * The reply's own topic (null = General). REQUIRED, not optional — every
   * caller must decide it explicitly so this can't silently regress back to
   * clearing every topic. Callers that never set a topic on their own
   * message (the MCP send tool, the AI worker) pass null, which is correct:
   * their message always lands in General.
   */
  topic: string | null
}): Promise<number> {
  const { account_id, contact_id, topic } = params
  if (!account_id && !contact_id) return 0

  const plan = await resolveThreadScopePlan(account_id, contact_id)

  const now = new Date().toISOString()
  let marked = 0

  // Staff replies also clear plain system notices (out-of-office autoreply and
  // similar) alongside the client's own messages — otherwise a conversation
  // that ever got one stays permanently "unread" no matter how many times
  // staff replies (2026-08-27). Chat-event marker rows are EXCLUDED: those are
  // acknowledged via their own handled_at flag (What's New panel), never via
  // read_at — see lib/portal/chat-events.ts.
  const NOT_CHAT_EVENT = '%<!-- chat-event:%'

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- chained Supabase query builder, shape varies per branch below
  const applyTopicFilter = (q: any) => (topic === null ? q.is("topic", null) : q.eq("topic", topic))

  for (const step of plan) {
    if (step.kind === "account") {
      let q = supabaseAdmin
        .from("portal_messages")
        .update({ read_at: now })
        .eq("account_id", step.account_id)
        .in("sender_type", ["client", "system"])
        .not("message", "ilike", NOT_CHAT_EVENT)
        .is("read_at", null)
      q = applyTopicFilter(q)
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
      q = applyTopicFilter(q)
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
      q = applyTopicFilter(q)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- client_kept_unread predates generated types
      q = (q as any).eq("client_kept_unread", false)
      const { count } = await q
      marked += count ?? 0
    }
  }

  return marked
}
