import { supabaseAdmin } from "@/lib/supabase-admin"
import { reportSystemError } from "@/lib/system-errors"

/**
 * Which of a contact's active "Company Closure" service deliveries still OWE us
 * the closure form — i.e. the ones the client should be prompted to fill in.
 *
 * Why this exists (Antonio, 2026-09-24 — DoctorGut / Patrick Covelli): a
 * Company Closure SD stays `active` for months after the client sends the form
 * (state dissolution, IRS closure…), so "an active closure exists" is NOT the
 * same as "the client still has to fill the form". The sidebar used the former
 * and nagged a fully-set-up client with an unlabelled form for the OLD company
 * being closed; he re-submitted it once because of that. This helper answers
 * the right question, per closure (never contact-wide — a client could have a
 * second, genuinely unsent closure), and drives the home-page closure card.
 *
 * SD scope mirrors resolveClosureSubject (lib/portal/closure-subject.ts): a
 * contact-only closure (account_id NULL, an untracked external LLC) on this
 * contact, or an account-scoped closure on any account this contact is linked
 * to via account_contacts.
 */

export interface PendingClosure {
  serviceDeliveryId: string
  accountId: string | null
  /** Name of the company being closed, when it's a CRM account. Null for a
   *  contact-only closure of an untracked LLC — its name is only known once
   *  the client has filled the form, which is exactly when this is no longer
   *  pending. */
  companyName: string | null
}

export interface ClosureSdForCheck {
  id: string
  account_id: string | null
  created_at: string
  source_closure_token: string | null
}

export interface ClosureProgressRow {
  service_delivery_id: string | null
  status: string | null
}

export interface ClosureSubmissionRow {
  token: string | null
  account_id: string | null
  contact_id: string | null
  status: string | null
  created_at: string
  completed_at?: string | null
}

const DONE_SUBMISSION_STATUSES = new Set(["completed", "reviewed"])

/**
 * Pure decision: has the closure form for THIS closure SD already been sent?
 * Any one of three independent proofs is enough:
 *  1. The wizard's own progress row, scoped to this exact SD, is `submitted`.
 *  2. The SD was auto-created FROM a submission (source_closure_token) that
 *     is completed/reviewed.
 *  3. LEGACY FALLBACK, only when unambiguous: this SD is the ONLY active
 *     closure in its scope (the account, or the contact's no-account
 *     closures), and a completed/reviewed submission for that same scope was
 *     completed on/after the SD was created. Needed for submissions made before
 *     the progress row carried a service_delivery_id (Patrick Covelli's two
 *     submissions, June/July 2026, have none). A closure_submissions row has no
 *     SD link, so with two closures in the same scope a submission can't be
 *     attributed — the rule then declines (card stays), never guesses (council,
 *     2026-09-24). The time bound keeps an OLD, finished closure's submission
 *     from silencing a NEW one; it uses the later of created_at/completed_at
 *     because a legacy emailed-link row is created when the link is sent,
 *     possibly before staff created the SD. Submissions already claimed by
 *     ANOTHER SD's source_closure_token are ignored.
 */
export function isClosureFormSubmitted(params: {
  sd: ClosureSdForCheck
  contactId: string
  progressRows: ClosureProgressRow[]
  submissions: ClosureSubmissionRow[]
  /** Every active closure SD being evaluated for this contact (used to decide
   *  whether proof 3 is unambiguous). Defaults to just `sd`. */
  allSds?: ClosureSdForCheck[]
}): boolean {
  const { sd, contactId, progressRows, submissions } = params
  const allSds = params.allSds ?? [sd]

  if (progressRows.some((r) => r.service_delivery_id === sd.id && r.status === "submitted")) {
    return true
  }

  const done = submissions.filter((s) => DONE_SUBMISSION_STATUSES.has(s.status ?? ""))

  if (sd.source_closure_token && done.some((s) => s.token === sd.source_closure_token)) {
    return true
  }

  const sameScope = (accountId: string | null) =>
    sd.account_id ? accountId === sd.account_id : !accountId
  const scopeSiblings = allSds.filter((o) => o.id !== sd.id && sameScope(o.account_id))
  if (scopeSiblings.length > 0) return false

  const claimedByOthers = new Set(
    allSds
      .filter((o) => o.id !== sd.id && o.source_closure_token)
      .map((o) => o.source_closure_token as string),
  )
  const sdCreated = new Date(sd.created_at).getTime()
  return done.some((s) => {
    const sameCompany = sd.account_id
      ? s.account_id === sd.account_id
      : s.contact_id === contactId && !s.account_id
    if (!sameCompany) return false
    if (s.token && claimedByOthers.has(s.token)) return false
    const times = [s.created_at, s.completed_at]
      .map((t) => (t ? new Date(t).getTime() : NaN))
      .filter((t) => Number.isFinite(t))
    if (times.length === 0 || !Number.isFinite(sdCreated)) return false
    return Math.max(...times) >= sdCreated
  })
}

export async function getPendingClosures(contactId: string): Promise<PendingClosure[]> {
  return (await getPendingClosuresOrNull(contactId)) ?? []
}

/**
 * Same as getPendingClosures, but returns NULL when the closures themselves
 * could not be looked up (instead of an empty list). For callers that must
 * tell "nothing owed" apart from "don't know" — e.g. the services page, which
 * keeps its old button rather than hiding it on a transient DB error.
 */
export async function getPendingClosuresOrNull(contactId: string): Promise<PendingClosure[] | null> {
  try {
    const { data: links, error: linksErr } = await supabaseAdmin
      .from("account_contacts")
      .select("account_id")
      .eq("contact_id", contactId)
    // Non-fatal: contact-only closures are still found without the links; only
    // account-scoped closures would be missed for this one render.
    if (linksErr) console.error("[getPendingClosures] account_contacts lookup failed:", linksErr.message)
    const linkedAccountIds = (links ?? []).map((l) => l.account_id as string)

    const orFilters = [`and(account_id.is.null,contact_id.eq.${contactId})`]
    if (linkedAccountIds.length) {
      orFilters.push(`account_id.in.(${linkedAccountIds.join(",")})`)
    }

    const { data: sds, error: sdErr } = await supabaseAdmin
      .from("service_deliveries")
      .select("id, account_id, created_at, source_closure_token")
      .eq("service_type", "Company Closure")
      .eq("status", "active")
      .or(orFilters.join(","))
      .order("created_at", { ascending: false })
    if (sdErr) {
      // Can't know which closures exist → no card this render. The card is the
      // only client entrance to the closure form, so make a persistent failure
      // visible rather than silently hiding it on every load.
      console.error("[getPendingClosures] closure SD lookup failed:", sdErr.message)
      reportSystemError({
        source: "server",
        route: "lib/portal/pending-closures",
        message: `closure SD lookup failed (home-page closure card hidden): ${sdErr.message}`,
        context: { contactId },
      }).catch(() => {})
      return null
    }
    const closures = (sds ?? []) as ClosureSdForCheck[]
    if (closures.length === 0) return []

    const closureAccountIds = Array.from(
      new Set(closures.map((c) => c.account_id).filter((id): id is string => !!id)),
    )

    const [progressRes, contactSubsRes, accountSubsRes] = await Promise.all([
      supabaseAdmin
        .from("wizard_progress")
        .select("service_delivery_id, status")
        .eq("wizard_type", "closure")
        .in("service_delivery_id", closures.map((c) => c.id)),
      supabaseAdmin
        .from("closure_submissions")
        .select("token, account_id, contact_id, status, created_at, completed_at")
        .eq("contact_id", contactId),
      closureAccountIds.length
        ? supabaseAdmin
            .from("closure_submissions")
            .select("token, account_id, contact_id, status, created_at, completed_at")
            .in("account_id", closureAccountIds)
        : Promise.resolve({ data: [] as ClosureSubmissionRow[], error: null }),
    ])

    // A failed proof lookup must never HIDE the only entrance to a form the
    // client may still owe — treat the missing proof as "not submitted".
    if (progressRes.error) console.error("[getPendingClosures] wizard_progress lookup failed:", progressRes.error.message)
    if (contactSubsRes.error) console.error("[getPendingClosures] closure_submissions (contact) lookup failed:", contactSubsRes.error.message)
    if (accountSubsRes.error) console.error("[getPendingClosures] closure_submissions (account) lookup failed:", accountSubsRes.error.message)

    const progressRows = (progressRes.data ?? []) as ClosureProgressRow[]
    const submissions = [
      ...((contactSubsRes.data ?? []) as ClosureSubmissionRow[]),
      ...((accountSubsRes.data ?? []) as ClosureSubmissionRow[]),
    ]

    const pendingSds = closures.filter(
      (sd) => !isClosureFormSubmitted({ sd, contactId, progressRows, submissions, allSds: closures }),
    )
    if (pendingSds.length === 0) return []

    const pendingAccountIds = Array.from(
      new Set(pendingSds.map((c) => c.account_id).filter((id): id is string => !!id)),
    )
    const nameById = new Map<string, string | null>()
    if (pendingAccountIds.length) {
      const { data: accs } = await supabaseAdmin
        .from("accounts")
        .select("id, company_name")
        .in("id", pendingAccountIds)
      for (const a of accs ?? []) nameById.set(a.id as string, (a.company_name as string | null) ?? null)
    }

    return pendingSds.map((sd) => ({
      serviceDeliveryId: sd.id,
      accountId: sd.account_id,
      companyName: sd.account_id ? nameById.get(sd.account_id) ?? null : null,
    }))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[getPendingClosures] failed:", msg)
    reportSystemError({
      source: "server",
      route: "lib/portal/pending-closures",
      message: `getPendingClosures threw (closure card/button state unknown): ${msg}`,
      context: { contactId },
    }).catch(() => {})
    return null
  }
}
