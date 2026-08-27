/**
 * Multi-option offers ("packages") — validation, pick-locking, and reset.
 *
 * dev job 3c1bb5fa. Reviewed twice (senior-engineer + ai-architect + bug-hunter)
 * before any of this was written; the shape below is a direct response to what
 * that review found, not a first draft:
 *
 *  - An offer with NO `packages` behaves exactly as it always has — nothing
 *    here runs, nothing downstream needs to know this feature exists.
 *  - The picked package's data is WRITTEN THROUGH onto the offer's own
 *    existing top-level columns (entity_type, formation_state, services,
 *    cost_summary, currency, bank_details, recurring_costs,
 *    installment_currency) at lock time. This is deliberate: every existing
 *    consumer of an offer (the amount engine, the signing webhook, referral
 *    commission, checkout, the contract page) reads those columns directly
 *    and needs ZERO changes, because by the time any of them run, a locked
 *    offer is indistinguishable from an ordinary single-option offer.
 *  - The bank account is always resolved fresh, "auto" by currency, from the
 *    PICKED package's currency — never a manually-pinned preference and never
 *    a stale snapshot. A package offer that let someone pin one specific bank
 *    account would show the wrong wire details the moment a client picked a
 *    different-currency option.
 *  - The lock itself is a compare-and-swap (`package_locked_at IS NULL`),
 *    checked by returned ROW COUNT — not merely the absence of a database
 *    error. That distinction matters: CLAUDE.md's own documented example of
 *    this pattern (lib/operations/banking-review.ts and its two siblings)
 *    does NOT check row count and would report a fake "success" to the loser
 *    of a race. The correct version already exists in this codebase —
 *    app/api/offers/release-commission/route.ts — and this copies it. On a
 *    lost race this additionally re-fetches and tells the caller whether
 *    their OWN pick already won (a network-timeout retry) or a genuinely
 *    different one did — the release-commission route doesn't need that
 *    distinction (its action is identical no matter who calls it); a package
 *    pick is not.
 *  - Renewal figures are NOT auto-applied to the client's account (Antonio,
 *    2026-08-26): that would be new automation this system has never had for
 *    a brand-new formation (verified — the only existing account-upgrade
 *    write path is gated to a different, unrelated contract_type). Instead,
 *    every package is REQUIRED to carry both renewal installment amounts
 *    before the offer can be created at all, so the number a staff member
 *    later types onto the account by hand is never missing from the record —
 *    only ever manually not-yet-copied.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { logAction } from "@/lib/mcp/action-log"
import { getBankDetailsByPreference } from "@/app/offer/[token]/contract/bank-defaults"
import { normalizeFormationState } from "@/lib/formation/states"
import { normalizeEntityType } from "@/lib/operations/offers"
import { parsePriceQuirk, resolveOfferCurrency } from "@/lib/offers/compute-offer-totals"
import { findInstallment, findSetupFeeSection, parsePrice } from "@/lib/operations/onboarding-account-upgrade"
import { resolveCreditSubject, subjectForDisplay, type CreditSubject } from "@/lib/operations/credit-subject"
import { availableCreditForDisplay } from "@/lib/operations/credit-netting"
import { PACKAGE_PICK_LOCKED_STATUSES } from "@/lib/offers/package-pick-status"
import type { Json } from "@/lib/database.types"

export interface OfferPackage {
  /** Stable, author-chosen id (e.g. "wy-smllc"). Unique within one offer. */
  key: string
  /** Shown to the client on the picker (e.g. "Wyoming — Single-Member LLC"). */
  label: string
  currency: string
  entity_type: string
  formation_state: string
  services: unknown
  cost_summary: unknown
  recurring_costs: unknown
  installment_currency?: string | null
}

function validateOnePackage(pkg: Record<string, unknown>, index: number): string | null {
  const label = pkg.label
  if (!label || typeof label !== "string") return `packages[${index}] must have a label`
  const tag = `packages[${index}] ("${label}")`

  if (!normalizeEntityType(pkg.entity_type as string | null | undefined)) {
    return `${tag}: company type is missing or not recognized`
  }
  if (!normalizeFormationState(pkg.formation_state)) {
    return `${tag}: US state is missing or not recognized`
  }
  if (!pkg.currency || typeof pkg.currency !== "string") {
    return `${tag}: currency must be set explicitly`
  }

  const services = Array.isArray(pkg.services) ? pkg.services : []
  const hasServicePrice = services.some(
    (s) => parsePriceQuirk((s as Record<string, unknown>)?.price) > 0,
  )
  const setupSection = findSetupFeeSection(pkg.cost_summary)
  const hasSetupTotal = !!setupSection?.total && parsePrice(setupSection.total) != null
  if (!hasServicePrice && !hasSetupTotal) {
    return `${tag}: must have a price (a service line or a Setup Fee total)`
  }

  // Antonio's rule (2026-08-26): every package must carry BOTH renewal
  // installments before the offer can be created — the account write is
  // manual, so the offer is the one place this is guaranteed captured.
  const inst1 = findInstallment(pkg.recurring_costs, "jan")
  if (!inst1 || parsePrice(inst1.price) == null) {
    return `${tag}: missing the 1st (January) renewal installment amount`
  }
  const inst2 = findInstallment(pkg.recurring_costs, "jun")
  if (!inst2 || parsePrice(inst2.price) == null) {
    return `${tag}: missing the 2nd (June) renewal installment amount`
  }

  return null
}

/**
 * Validate a `packages` array. Returns the first error, or null when the
 * value is absent/empty (an ordinary single-option offer) or every package is
 * complete. Requires at least 2 packages — one "option" is a config mistake,
 * not a feature — and unique, non-blank keys.
 */
export function validatePackages(packages: unknown): string | null {
  if (packages == null) return null
  if (!Array.isArray(packages) || packages.length === 0) return null
  if (packages.length < 2) {
    return "packages must have at least 2 options — for a single price, omit packages entirely"
  }

  const seenKeys = new Set<string>()
  for (let i = 0; i < packages.length; i++) {
    const pkg = (packages[i] ?? {}) as Record<string, unknown>
    const key = pkg.key
    if (!key || typeof key !== "string") return `packages[${i}] must have a unique key`
    if (seenKeys.has(key)) return `packages[${i}]: duplicate key "${key}"`
    seenKeys.add(key)
    const err = validateOnePackage(pkg, i)
    if (err) return err
  }
  return null
}

export interface PackagePickResult {
  success: boolean
  outcome:
    | "locked"
    | "already_locked_same"
    | "already_locked_different"
    | "not_found"
    | "no_packages"
    | "unknown_package"
    | "error"
  selected_package_key?: string | null
  error?: string
}

/**
 * Lock a client's package pick. See file header for the full design — this is
 * the one place a multi-option offer's real price/state/company-type/renewal
 * fields get written, and the one place two near-simultaneous requests are
 * resolved to exactly one winner.
 */
export async function lockPackagePick(params: {
  token: string
  packageKey: string
  actor?: string
}): Promise<PackagePickResult> {
  const { data: offer, error: fetchErr } = await supabaseAdmin
    .from("offers")
    // eslint-disable-next-line no-restricted-syntax -- packages/selected_package_key/package_locked_at postdate generated types (migration 20260826-1800)
    .select("token, packages, package_locked_at, selected_package_key, client_email, contact_id" as never)
    .eq("token", params.token)
    .maybeSingle()

  if (fetchErr || !offer) {
    return { success: false, outcome: "not_found", error: `Offer not found: ${params.token}` }
  }

  const row = offer as unknown as { packages: unknown; client_email: string | null; contact_id: string | null }
  const packages = Array.isArray(row.packages) ? (row.packages as unknown as OfferPackage[]) : []
  if (packages.length === 0) {
    return { success: false, outcome: "no_packages", error: "This offer has no selectable options" }
  }
  const chosen = packages.find((p) => p.key === params.packageKey)
  if (!chosen) {
    return {
      success: false,
      outcome: "unknown_package",
      error: `No package with key "${params.packageKey}" on this offer`,
    }
  }

  const currency = resolveOfferCurrency(chosen.currency, chosen.cost_summary)
  // Always "auto" by the PICKED package's own currency — never a manually
  // pinned bank, never the offer's pre-pick placeholder currency. This is the
  // direct fix for the wrong-bank-for-the-currency defect the review found.
  const bankDetails = getBankDetailsByPreference("auto", currency)

  // Found by adversarial review: a held credit is snapshotted at OFFER
  // CREATION in whichever currency the author typed first — but a package
  // offer can span currencies, and computeOfferPayable nets `credit_amount`
  // against `gross` with NO currency check of its own. Left untouched, a
  // credit snapshotted in one currency would net against a different
  // currency's charge the moment the client picks a different-currency
  // package — real money computed wrong, not just a display error. Re-resolve
  // fresh, in the PICKED currency, exactly the same way createOffer does it
  // the first time — this either confirms the same credit still applies, finds
  // a DIFFERENT credit that now applies, or correctly clears it to zero.
  let creditAmount: number | null = null
  let creditPaymentId: string | null = null
  let creditKind: string | null = null
  try {
    const subject = row.contact_id
      ? ({ kind: "resolved", contactId: row.contact_id, email: "" } as CreditSubject)
      : await resolveCreditSubject(row.client_email, supabaseAdmin)
    const displayContactId = subjectForDisplay(subject)
    if (displayContactId) {
      const held = await availableCreditForDisplay({ contactId: displayContactId }, currency, supabaseAdmin)
      if (held.amount > 0) {
        creditAmount = held.amount
        creditPaymentId = held.creditId
        creditKind = held.kind
      }
    }
  } catch (err) {
    // Never let a display-credit re-check block the lock itself — but never
    // silently keep a stale, wrong-currency credit either. Falling through
    // with credit cleared to null is the safe failure: worst case the client
    // is offered a deduction they're owed one currency too late, which staff
    // can correct by hand; the alternative (keeping the stale value) risks
    // silently under-charging a real card/wire payment.
    console.error("[lockPackagePick] credit re-check failed, clearing credit fields:", err)
  }

  const { data: claimed, error: claimErr } = await supabaseAdmin
    .from("offers")
    .update({
      selected_package_key: chosen.key,
      package_locked_at: new Date().toISOString(),
      entity_type: normalizeEntityType(chosen.entity_type),
      formation_state: normalizeFormationState(chosen.formation_state),
      services: chosen.services as Json,
      cost_summary: chosen.cost_summary as Json,
      recurring_costs: (chosen.recurring_costs ?? null) as Json,
      installment_currency: chosen.installment_currency ?? currency,
      currency,
      bank_details: bankDetails as unknown as Json,
      credit_amount: creditAmount,
      credit_payment_id: creditPaymentId,
      credit_kind: creditKind,
    } as never)
    .eq("token", params.token)
    .is("package_locked_at" as never, null)
    .select("token")

  if (claimErr) {
    return { success: false, outcome: "error", error: `Could not lock the pick: ${claimErr.message}` }
  }

  if (!claimed || claimed.length === 0) {
    // Lost the race. Re-fetch to tell "your own retry, already won" apart
    // from "a genuinely different pick already won" — the two need different
    // answers, unlike a plain admin claim where either caller gets the same
    // outcome regardless of who wins.
    const { data: current } = await supabaseAdmin
      .from("offers")
      // eslint-disable-next-line no-restricted-syntax -- see select above
      .select("selected_package_key" as never)
      .eq("token", params.token)
      .maybeSingle()
    const already = (current as unknown as { selected_package_key: string | null } | null)
      ?.selected_package_key ?? null
    if (already === params.packageKey) {
      return { success: true, outcome: "already_locked_same", selected_package_key: already }
    }
    return {
      success: false,
      outcome: "already_locked_different",
      selected_package_key: already,
      error: "A choice was already locked in for this offer.",
    }
  }

  logAction({
    actor: params.actor || "client",
    action_type: "update",
    table_name: "offers",
    record_id: params.token,
    summary: `Package picked and locked: ${chosen.label} (${chosen.key})`,
    details: {
      package_key: chosen.key,
      entity_type: chosen.entity_type,
      formation_state: chosen.formation_state,
      currency,
    },
  })

  return { success: true, outcome: "locked", selected_package_key: chosen.key }
}

/**
 * Staff-only escape hatch — undo a client's locked pick so they can choose
 * again. Deliberately does NOT try to revert the top-level fields the lock
 * wrote: nothing treats them as authoritative while `package_locked_at` is
 * NULL on an offer that carries packages (the client page shows the picker
 * again, not a resolved contract), and the next lock overwrites them anyway.
 *
 * Refuses once the offer has been signed/completed (found by adversarial
 * review): resetting a signed deal would show the client a picker again on an
 * already-closed engagement, and a genuine re-pick attempt would be refused
 * downstream anyway by pick-package's own status check — better to say so
 * here, plainly, than let staff think the reset did something useful.
 *
 * The refusal is enforced by the UPDATE's own WHERE clause, not by a
 * separate read-then-check (found by a second adversarial pass): a plain
 * "read status, decide, then write unconditionally" has a gap wide enough
 * for a client's signature to land in between — the read sees an open deal,
 * the write still fires a moment later on what is now a signed one, and the
 * one record of which option the client chose is gone. Tying the guard to
 * the write itself, and reading the row count instead of just the absence
 * of an error, closes that gap the same way lockPackagePick's own claim
 * does it.
 */
export async function resetPackagePick(params: {
  token: string
  actor: string
  reason?: string
}): Promise<{ success: boolean; error?: string }> {
  const lockedStatusList = `(${PACKAGE_PICK_LOCKED_STATUSES.map((s) => `"${s}"`).join(",")})`
  const { data: claimed, error } = await supabaseAdmin
    .from("offers")
    .update({
      package_locked_at: null,
      selected_package_key: null,
      // ⛔ CLEARED TOGETHER (bug-hunter, second council pass, 2026-08-27): a client-chosen
      // split is pinned against the PICKED package's price. Re-picking a different package
      // changes services/cost_summary/currency (lockPackagePick, below) but leaves a stale
      // split plan sized for the OLD price — payment_choice_made_at stays set, so the client
      // is never re-offered the choice, and checkout hard-refuses on the resulting mismatch
      // with no recovery path. Resetting the pick must reopen the payment choice too.
      payment_plan: null,
      payment_choice_made_at: null,
    } as never)
    .eq("token", params.token)
    .not("status", "in", lockedStatusList)
    .select("token")

  if (error) return { success: false, error: error.message }

  if (!claimed || claimed.length === 0) {
    // Either the offer doesn't exist, or it just became signed/completed
    // between a caller's own status check and this write — re-fetch to tell
    // the two apart and give staff an accurate reason either way.
    const { data: current } = await supabaseAdmin
      .from("offers")
      .select("status")
      .eq("token", params.token)
      .maybeSingle()
    if (!current) {
      return { success: false, error: `Offer not found: ${params.token}` }
    }
    return {
      success: false,
      error: `This offer is already ${current.status} — resetting the pick would show the client a picker on a closed deal, not undo the signature or payment.`,
    }
  }

  logAction({
    actor: params.actor,
    action_type: "update",
    table_name: "offers",
    record_id: params.token,
    summary: `Package pick reset${params.reason ? `: ${params.reason}` : ""}`,
    details: { reason: params.reason ?? null },
  })

  return { success: true }
}
