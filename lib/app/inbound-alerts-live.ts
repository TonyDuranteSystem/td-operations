/**
 * TD Social — the working part of the WhatsApp / email phone alerts (server; dev job 2072bc3e, Step 2 pull request D; Council-reviewed plan of 5 Nov 2026).
 *
 * Loaded ONLY by `inbound-alerts.ts`, and only when the Apple key is set and a message passed the cheap checks. ORDER OF WORK, each step ends the job quietly
 * if its answer is "no":
 *   TD Social switch on → claim the message in the memory table (once ever; past the flood cap it is silent) → who wants it (each person's own switches) →
 *   the CRM name of the conversation (bounded; none = generic words) → the phone leg (which re-checks the staff directory, the muted tabs, the phones).
 * The switch comes BEFORE the claim on purpose: while TD Social is off nothing may be written, or a message claimed-and-dropped now could never alert later.
 * A claim that cannot be made (database trouble) counts as "already alerted": no alert, never a duplicate. The whole job is bounded and never throws.
 *
 * `runInboundJob` is pure orchestration over injected dependencies (tests use fakes); `runInboundJobsLive` wires the real ones.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isAdmin, isStaffUser } from "@/lib/auth"
import { normalizeRole } from "@/lib/auth/role-door"
import { listAllAuthUsers } from "@/lib/auth-admin-helpers"
import { isSocialAppEnabled } from "@/lib/app/enabled"
import { readState } from "@/lib/app/state"
import { tabsFor, type AppTab } from "@/lib/app/tabs"
import { effectivePrefs, type StoredPrefs } from "@/lib/app/prefs"
import { MAX_RECIPIENTS, SIDE_LOOKUP_MS, sendToPhonesLive } from "@/lib/app/send-to-phones"
import type { InboundJob } from "@/lib/app/inbound-alerts"
import type { PhoneAlert } from "@/lib/app/phone-leg"

/** At most this many messages of one thread are claimed in one go (the cap per mailbox stops the rest anyway). */
export const MAX_CLAIMS_PER_JOB = 10
/** At most this many conversations are alerted in one batch; the rest of a huge catch-up stays silent (their unread numbers still count). */
export const MAX_JOBS_PER_BATCH = 5

export type ClaimResult = "send" | "duplicate" | "silent"
export type InboundOutcome = "off" | "not sent" | "nobody" | "sent"

export interface InboundDeps {
  isOn: () => Promise<boolean>
  claim: (source: string, messageId: string) => Promise<ClaimResult>
  recipients: (job: InboundJob) => Promise<string[]>
  nameFor: (job: InboundJob) => Promise<string | null>
  send: (alert: PhoneAlert) => Promise<unknown>
}

function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>(resolve => {
    const timer = setTimeout(() => resolve(fallback), ms)
    work.then(v => { clearTimeout(timer); resolve(v) }, () => { clearTimeout(timer); resolve(fallback) })
  })
}

/**
 * PURE. Does this person want this kind of alert, by their own switches? WhatsApp: the person has the WhatsApp tab and the switch is on (default on).
 * Email: the person may open that mailbox and its switch is on (default on only when it is their ONLY mailbox). Muted tabs are checked again later by the
 * phone leg; they are not decided here.
 */
export function wantsInboundAlert(kind: InboundJob["kind"], place: string | undefined, tabs: readonly AppTab[], stored: StoredPrefs | null): boolean {
  const prefs = effectivePrefs(tabs, stored)
  if (kind === "whatsapp_message") return prefs.whatsapp === true
  return place !== undefined && prefs.email?.[place] === true
}

export async function runInboundJob(job: InboundJob, deps: InboundDeps): Promise<InboundOutcome> {
  if (!(await deps.isOn())) return "off"

  // claim: the first caller wins, ever. Any 'send' among a thread's messages means ONE alert for the conversation.
  let send = false
  for (const id of job.messageIds.slice(0, MAX_CLAIMS_PER_JOB)) {
    if ((await deps.claim(job.source, id)) === "send") send = true
  }
  if (!send) return "not sent"

  const userIds = (await deps.recipients(job)).slice(0, MAX_RECIPIENTS)
  if (userIds.length === 0) return "nobody"

  const name = await withDeadline(deps.nameFor(job), SIDE_LOOKUP_MS, null)
  await deps.send({
    source: "staff",
    userIds,
    kind: job.kind,
    // the lock screen never shows these two for these kinds; the wording rule builds the text from the kind, the name and the mailbox only
    title: "",
    body: "",
    name,
    dm: false,
    place: job.place ?? null,
    tag: job.tag,
  })
  return "sent"
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- newer tables / functions than the generated types
const db = () => supabaseAdmin as unknown as { from: (t: string) => any; rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> }

export async function claimLive(source: string, messageId: string): Promise<ClaimResult> {
  try {
    const { data, error } = await db().rpc("social_app_claim_alert", { p_source: source, p_message_id: messageId })
    if (error) return "duplicate"
    return data === "send" || data === "silent" ? data : "duplicate"
  } catch {
    return "duplicate"
  }
}

/** The staff who want this alert by their own switches. Any doubt about a person (their login or their switches cannot be read) leaves that person out. */
export async function recipientsLive(job: InboundJob): Promise<string[]> {
  try {
    const users = (await listAllAuthUsers()).filter(u => isStaffUser(u) && !u.banned_until).slice(0, MAX_RECIPIENTS)
    const answers = await Promise.all(users.map(async u => {
      try {
        const tabs = tabsFor({ authRole: normalizeRole(u.app_metadata?.role), isAdmin: isAdmin(u), isStaff: true, marketingChat: false })
        const stored = await readState(u.id)
        return wantsInboundAlert(job.kind, job.place, tabs, stored) ? u.id : null
      } catch {
        return null
      }
    }))
    return answers.filter((id): id is string => id !== null)
  } catch {
    return []
  }
}

/** The CRM name of the person, lead or company this conversation is linked to (the person first, then the lead, then the company). Null when there is none. */
export async function nameLive(job: InboundJob): Promise<string | null> {
  try {
    let { contactId, leadId, accountId } = job.who
    if (job.who.groupId) {
      // the chat may have been linked a moment ago (the bridge links a new chat on the spot), so read the link now rather than trust what the caller saw
      const { data } = await db().from("messaging_groups").select("contact_id, lead_id, account_id").eq("id", job.who.groupId).maybeSingle()
      if (data) { contactId = data.contact_id ?? null; leadId = data.lead_id ?? null; accountId = data.account_id ?? null }
    }
    const pick = async (table: string, column: string, id: string | null | undefined): Promise<string | null> => {
      if (!id) return null
      const { data } = await db().from(table).select(column).eq("id", id).maybeSingle()
      const v = data?.[column]
      return typeof v === "string" && v.trim() !== "" ? v : null
    }
    return (await pick("contacts", "full_name", contactId)) ?? (await pick("leads", "full_name", leadId)) ?? (await pick("accounts", "company_name", accountId))
  } catch {
    return null
  }
}

export function liveInboundDeps(): InboundDeps {
  return { isOn: isSocialAppEnabled, claim: claimLive, recipients: recipientsLive, nameFor: nameLive, send: sendToPhonesLive }
}

/** The real thing. Never throws. A huge catch-up alerts at most MAX_JOBS_PER_BATCH conversations; each job is independent. */
export async function runInboundJobsLive(jobs: readonly InboundJob[], deps: InboundDeps = liveInboundDeps()): Promise<void> {
  for (const job of jobs.slice(0, MAX_JOBS_PER_BATCH)) {
    try {
      await runInboundJob(job, deps)
    } catch (e) {
      console.error("[social-app] inbound alert failed:", e instanceof Error ? e.name : "unknown")
    }
  }
}
