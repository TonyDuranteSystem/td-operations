/**
 * TD Social — new WhatsApp messages and new emails as phone alerts (dev job 2072bc3e, Step 2 pull request D; Council-reviewed plan of 5 Nov 2026).
 *
 * Nobody was alerted about these before: they have NO web alert, so they go to TD Social phones ONLY and never touch the browser senders.
 * This file holds the cheap, pure part (is this message a candidate at all?) and the two doorways the existing save paths call. The doorways are the FIRST
 * line of the leg: no Apple key means they return at once, load nothing and read nothing, so until the key is set production behaves exactly as before.
 * They NEVER throw and never reject: a failed phone alert must not fail the save that caused it. The heavy part (memory table, recipients, names, sending)
 * lives in `inbound-alerts-live.ts` and is loaded only when there is something to alert.
 *
 * WHAT MAY ALERT
 *  - Email: a message in the Inbox, still unread, not from one of our own addresses, not spam / trash / draft / sent, with a real time stamp that is under 15
 *    minutes old. A re-save of an old thread (webhook, 10-minute job, backfill, re-index after a send) therefore finds nothing recent and sends nothing.
 *  - WhatsApp: a message from the CUSTOMER (never our own reply), under 3 minutes old by the same rule that already makes the CRM beep, carrying a real
 *    provider time stamp (never a defaulted "now") and a real message id, and newly inserted (not already stored). One alert per chat per batch.
 * Whatever passes is then CLAIMED once in the memory table (so it can never alert twice) and held to a flood cap (see the migration). Past the cap it is silent.
 */
import { apnsConfigured } from "@/lib/app/apns-key"
import { isFreshInbound } from "@/lib/messaging/inbound-sound"
import { isOwnMailboxAddress } from "@/lib/gmail"

export const EMAIL_MAX_AGE_MS = 15 * 60_000
/** A little clock skew into the future is fine; more than this is nonsense (a forged or broken date must not alert). */
const FUTURE_SKEW_MS = 5 * 60_000
/** Labels that mean "this is not a new message in the Inbox for a person to react to". */
const NOT_INBOX_LABELS = ["SPAM", "TRASH", "DRAFT", "SENT"] as const

/** The facts about one saved email message that decide whether it may alert (the same names the saved row uses). */
export interface EmailAlertFacts {
  message_id?: string | null
  thread_id?: string | null
  from_email?: string | null
  internal_date?: string | null
  is_unread?: boolean | null
  label_ids?: readonly string[] | null
  account_id?: string | null
  contact_id?: string | null
  lead_id?: string | null
}

/** PURE. May this saved message alert at all? (It still has to be claimed once and fit under the flood cap.) */
export function isNewEmailCandidate(row: EmailAlertFacts, nowMs: number): boolean {
  if (typeof row.message_id !== "string" || row.message_id.trim() === "") return false
  if (typeof row.thread_id !== "string" || row.thread_id.trim() === "") return false
  if (row.is_unread !== true) return false
  const labels = Array.isArray(row.label_ids) ? row.label_ids : []
  if (!labels.includes("INBOX")) return false
  if (NOT_INBOX_LABELS.some(l => labels.includes(l))) return false
  const from = typeof row.from_email === "string" ? row.from_email.trim() : ""
  if (!from || isOwnMailboxAddress(from)) return false
  const t = typeof row.internal_date === "string" ? Date.parse(row.internal_date) : NaN
  if (!Number.isFinite(t)) return false
  const age = nowMs - t
  return age <= EMAIL_MAX_AGE_MS && age >= -FUTURE_SKEW_MS
}

/** The facts about one WhatsApp message the bridge just tried to save. */
export interface WhatsAppAlertFacts {
  externalId?: string | null
  direction: string
  createdAt: string
  /** true only when the provider sent a real, sane time stamp (the parser defaults a missing or silly one to "now", which must never count as fresh) */
  tsReal?: boolean
}

/** PURE. May this just-inserted WhatsApp message alert at all? */
export function isNewWhatsAppCandidate(m: WhatsAppAlertFacts, now: Date): boolean {
  if (m.tsReal !== true) return false
  if (typeof m.externalId !== "string" || m.externalId.trim() === "") return false
  return isFreshInbound(m.direction, m.createdAt, now)
}

/** One thing to alert about, already narrowed to what may alert. */
export interface InboundJob {
  kind: "email_message" | "whatsapp_message"
  /** the memory table's source: "email:support", "email:antonio" or "whatsapp:<chat id>" (the flood cap applies per source and across all of them) */
  source: string
  /** the ids to claim, in order: Gmail message ids, or the one newest WhatsApp message id of the chat */
  messageIds: string[]
  /** the mailbox of an email ("support" | "antonio") */
  place?: string
  /** collapses a burst on the lock screen into one line per conversation */
  tag: string
  /** what the CRM links the conversation to (the name on the lock screen comes from here, never from the message) */
  who: { groupId?: string | null; contactId?: string | null; leadId?: string | null; accountId?: string | null }
}

/** PURE. The jobs a saved Gmail thread produces: at most one (a thread's new messages become ONE alert). */
export function emailJobsFor(mailbox: string, rows: readonly EmailAlertFacts[], nowMs: number): InboundJob[] {
  if (mailbox !== "support" && mailbox !== "antonio") return []
  const fresh = rows.filter(r => isNewEmailCandidate(r, nowMs))
  if (fresh.length === 0) return []
  const byThread = new Map<string, EmailAlertFacts[]>()
  for (const r of fresh) {
    const list = byThread.get(r.thread_id as string) ?? []
    list.push(r)
    byThread.set(r.thread_id as string, list)
  }
  return Array.from(byThread.entries()).map(([threadId, list]) => {
    const linked = list.find(r => r.contact_id || r.lead_id || r.account_id) ?? list[0]
    return {
      kind: "email_message" as const,
      source: `email:${mailbox}`,
      messageIds: list.map(r => r.message_id as string),
      place: mailbox,
      tag: `email:${mailbox}:${threadId}`,
      who: { contactId: linked.contact_id ?? null, leadId: linked.lead_id ?? null, accountId: linked.account_id ?? null },
    }
  })
}

/** PURE. One job per chat for a batch of just-inserted WhatsApp messages: the newest candidate of each chat. */
export function whatsAppJobsFor(items: readonly { groupId: string; message: WhatsAppAlertFacts }[], now: Date): InboundJob[] {
  const newest = new Map<string, WhatsAppAlertFacts>()
  for (const it of items) {
    if (typeof it.groupId !== "string" || it.groupId === "") continue
    if (!isNewWhatsAppCandidate(it.message, now)) continue
    const have = newest.get(it.groupId)
    if (!have || Date.parse(it.message.createdAt) >= Date.parse(have.createdAt)) newest.set(it.groupId, it.message)
  }
  return Array.from(newest.entries()).map(([groupId, m]) => ({
    kind: "whatsapp_message" as const,
    source: `whatsapp:${groupId}`,
    messageIds: [m.externalId as string],
    tag: `whatsapp:${groupId}`,
    who: { groupId },
  }))
}

/** Run the jobs through the heavy part. Never rejects. The key check comes first so nothing is loaded when TD Social alerts are not set up. */
function runJobs(jobs: InboundJob[]): Promise<void> {
  if (jobs.length === 0 || !apnsConfigured()) return Promise.resolve()
  return import("@/lib/app/inbound-alerts-live")
    .then(m => m.runInboundJobsLive(jobs))
    .then(
      () => undefined,
      (e: unknown) => { console.error("[social-app] inbound alert failed:", e instanceof Error ? e.name : "unknown") },
    )
}

/** The doorway for a saved Gmail thread. Resolves when the alert is done (callers cap their wait with `waitForPhoneLeg`). Never rejects. */
export function alertNewEmails(mailbox: string, rows: readonly EmailAlertFacts[], nowMs: number = Date.now()): Promise<void> {
  try {
    return runJobs(emailJobsFor(mailbox, rows, nowMs))
  } catch {
    return Promise.resolve()
  }
}

/** The doorway for WhatsApp messages the bridge just saved (only the ones that were newly inserted). Never rejects. */
export function alertNewWhatsApp(items: readonly { groupId: string; message: WhatsAppAlertFacts }[], now: Date = new Date()): Promise<void> {
  try {
    return runJobs(whatsAppJobsFor(items, now))
  } catch {
    return Promise.resolve()
  }
}
