import { supabaseAdmin } from "@/lib/supabase-admin"

/**
 * Resolves WHICH company a client's closure-wizard visit is actually for.
 *
 * Root-cause fix for dev job fbbf4abe's post-build findings (4-reviewer
 * council — senior-engineer, ai-architect, bug-hunter, project-director, all
 * independently converged on the same defect): the wizard page used to fill
 * in whichever company the portal had "currently selected" for the client,
 * completely independent of which closure the client was actually trying to
 * complete. For a client with more than one company (37 real contacts today
 * per the 2026-08-26 audit), or one managed company plus an untracked one
 * (the flexible-wizard-type's own stated use case), that could attach — or
 * even MERGE — a closure onto the wrong company's live record.
 *
 * Fix: resolve the subject from the client's own PENDING "Company Closure"
 * service delivery — the record staff already correctly created for the
 * right company — instead of the ambient "current account" default. This is
 * server-side and runs regardless of which link the client used to arrive
 * (the wizard has at least 5 real/potential entry points; patching each one
 * to carry an explicit id was tried and rejected in review as fragile — a
 * future link that forgets the parameter silently falls back to the old,
 * broken behavior. Resolving here covers all of them, present and future).
 *
 * Membership check uses the raw account_contacts link table, NOT
 * getPortalAccounts() — that helper filters to Active/Suspended accounts only
 * (Senior Engineer finding: a legitimate closure of a Delinquent/Cancelled
 * account would otherwise be invisible here).
 */

export interface ClosureSubjectResolved {
  kind: "resolved"
  serviceDeliveryId: string
  accountId: string | null
  contactId: string
  /** Prefill source. NEVER an assumed default — null when there is no
   *  specific company on record to prefill from (the contact-only /
   *  untracked-LLC case), per the AI Architect's prefill finding: filling in
   *  ANY other company's name/EIN here is exactly the bug being fixed. */
  companyName: string | null
  ein: string | null
  stateOfFormation: string | null
}

export interface ClosureSubjectNone {
  kind: "none"
  contactId: string
}

/** Never actually observed in production (verified 2026-08-26: zero contacts
 *  have ever had two simultaneous pending closures) but the resolver must not
 *  silently guess if it ever happens. Falls back to the most recently created
 *  pending closure, and the caller must disclose that choice to the client
 *  rather than pick one unannounced. */
export interface ClosureSubjectAmbiguous {
  kind: "ambiguous"
  contactId: string
  chosen: ClosureSubjectResolved
  otherCount: number
}

export type ClosureSubjectResolution =
  | ClosureSubjectResolved
  | ClosureSubjectNone
  | ClosureSubjectAmbiguous

export async function resolveClosureSubject(
  contactId: string,
): Promise<ClosureSubjectResolution> {
  const { data: links } = await supabaseAdmin
    .from("account_contacts")
    .select("account_id")
    .eq("contact_id", contactId)
  const linkedAccountIds = (links ?? []).map((l) => l.account_id as string)

  const orFilters = [`and(account_id.is.null,contact_id.eq.${contactId})`]
  if (linkedAccountIds.length) {
    orFilters.push(`account_id.in.(${linkedAccountIds.join(",")})`)
  }

  const { data: sds } = await supabaseAdmin
    .from("service_deliveries")
    .select("id, account_id, contact_id, created_at")
    .eq("service_type", "Company Closure")
    .eq("status", "active")
    .or(orFilters.join(","))
    .order("created_at", { ascending: false })

  const candidates = sds ?? []
  if (candidates.length === 0) {
    return { kind: "none", contactId }
  }

  const resolveOne = async (sd: {
    id: string
    account_id: string | null
  }): Promise<ClosureSubjectResolved> => {
    let companyName: string | null = null
    let ein: string | null = null
    let stateOfFormation: string | null = null
    if (sd.account_id) {
      const { data: acc } = await supabaseAdmin
        .from("accounts")
        .select("company_name, ein_number, state_of_formation")
        .eq("id", sd.account_id)
        .maybeSingle()
      companyName = (acc?.company_name as string | null) ?? null
      ein = (acc?.ein_number as string | null) ?? null
      stateOfFormation = (acc?.state_of_formation as string | null) ?? null
    }
    return {
      kind: "resolved",
      serviceDeliveryId: sd.id,
      accountId: sd.account_id,
      contactId,
      companyName,
      ein,
      stateOfFormation,
    }
  }

  const chosen = await resolveOne(candidates[0])
  if (candidates.length === 1) return chosen
  return {
    kind: "ambiguous",
    contactId,
    chosen,
    otherCount: candidates.length - 1,
  }
}

/**
 * Server-side re-check at SUBMIT time (not just page-render time) that a
 * client-supplied service_delivery_id genuinely names a still-active closure
 * this contact is actually linked to — Senior Engineer's finding: resolving
 * the subject once when the page loads and then trusting it unconditionally
 * on submit leaves a stale-tab / cancelled-in-the-meantime / tampered-id
 * window open. Returns null (deny) for anything that doesn't check out:
 * record not found, wrong service type, not active (staff already
 * cancelled/completed it — a stale link must never resurrect a closed
 * matter), or the account/contact doesn't actually belong to this contact.
 */
export async function verifyClosureServiceDelivery(
  serviceDeliveryId: string,
  contactId: string,
): Promise<{ accountId: string | null } | null> {
  const { data: sd } = await supabaseAdmin
    .from("service_deliveries")
    .select("id, account_id, contact_id, service_type, status")
    .eq("id", serviceDeliveryId)
    .maybeSingle()
  if (!sd || sd.service_type !== "Company Closure" || sd.status !== "active") return null

  if (sd.account_id) {
    const { data: link } = await supabaseAdmin
      .from("account_contacts")
      .select("account_id")
      .eq("account_id", sd.account_id)
      .eq("contact_id", contactId)
      .maybeSingle()
    if (!link) return null
    return { accountId: sd.account_id as string }
  }
  // Contact-only closure — must belong to THIS contact, not just any contact.
  if (sd.contact_id !== contactId) return null
  return { accountId: null }
}
