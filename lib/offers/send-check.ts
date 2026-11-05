/**
 * ONE place that decides "can this offer be sent?" (offer builder Part 1, dev job d2971d11).
 *
 * Before this file the Send checks lived inside publishOffer (the CRM Send button, Publish Offer and Claude's offer_send
 * tool). The box beside the Send buttons has to say exactly what the real Send will say, so both call this function.
 *
 * The order (tests/unit/offer-send-gate-parity.test.ts freezes it):
 *   client email -> yearly fee -> still a draft -> new services ready -> approved wording frozen
 * (The lead page's old Activate Lead button was a second door with a smaller list; it was removed — the lead page sends an
 * offer through Send only.) The client's portal login is the step after these; it CREATES the login, so it is never run here.
 *
 * Two modes:
 *   "send"    the real send. The FIRST problem stops everything after it, exactly like the old code (the wording step WRITES,
 *             so it must never run once an earlier check failed). A lookup that fails is a blocker (the old code skipped the
 *             yearly-fee and package reads silently when they failed — that was the one deliberate change).
 *   "preview" the read-only box. Every step runs, nothing is written (the wording is worked out in memory), a lookup that
 *             fails is listed under "not checked" instead of blocking, and the risk rows are added.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { yearlyFeeMissingReason } from "@/lib/offers/annual-maintenance-wording"
import { offerServicesReadiness, type ReadinessBlocker } from "@/lib/offers/service-readiness"
import { ensureOfferContractTexts, type EnsureOptions } from "@/lib/offers/contract-texts-snapshot"
import { agreementCoverageGap, agreementCoverageWarnings } from "@/lib/offers/standalone-agreement-lines"
import { multiAgreementsEnabled } from "@/lib/offers/multi-agreements-switch"

export type SendCheckMode = "send" | "preview"
export type SendCheckStep = "email" | "yearly_fee" | "status" | "services" | "wording"

export interface SendCheckBlocker {
  step: SendCheckStep
  /** The reason in plain English, without the "Cannot publish:" the real Send adds in front. */
  message: string
  /** True when the check could not run (a lookup failed or threw) rather than found something wrong. */
  couldNotCheck?: boolean
  /** For the "services" step: the engine's reasons one by one, each with a link to fix it (what the CRM pop-up shows). */
  readiness?: ReadinessBlocker[]
}

export interface OfferForSendCheck {
  token: string
  status?: string | null
  client_email?: string | null
  services?: unknown
  bundled_pipelines?: unknown
  recurring_costs?: unknown
  installment_currency?: string | null
  contract_type?: string | null
}

export interface SendCheckResult {
  /** In the order the real Send checks them. In "send" mode at most one step (the first that failed). */
  blockers: SendCheckBlocker[]
  /** Goes out anyway, but Antonio should look. Only filled in "preview" mode. */
  risks: string[]
  /** What this check could not look at. Only filled in "preview" mode. */
  notChecked: string[]
  /** Who the offer would go to (the offer's own client email). */
  willSendTo: string | null
}

/** "could not check ..." -> "Could not check ..." for the list the box shows. */
const sentence = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)

/** Service lines saved with a name only (no job name): the engine cannot tell whether they have steps or a contract. */
function nameOnlyServiceLines(services: unknown): string[] {
  if (!Array.isArray(services)) return []
  const out: string[] = []
  for (const l of services as unknown[]) {
    if (!l || typeof l !== "object") continue
    const line = l as Record<string, unknown>
    const pipeline = typeof line.pipeline_type === "string" ? line.pipeline_type.trim() : ""
    const name = typeof line.name === "string" ? line.name.trim() : ""
    if (!pipeline && name) out.push(name)
  }
  return out
}

export async function offerSendCheck(p: { offer: OfferForSendCheck; mode: SendCheckMode }): Promise<SendCheckResult> {
  const { offer, mode } = p
  const preview = mode === "preview"
  const out: SendCheckResult = { blockers: [], risks: [], notChecked: [], willSendTo: offer.client_email || null }

  /** On the real send the first problem stops every later step; the preview runs them all. */
  const stopped = () => !preview && out.blockers.length > 0
  const problem = (b: SendCheckBlocker) => {
    if (preview && b.couldNotCheck) out.notChecked.push(sentence(b.message))
    else out.blockers.push(b)
  }

  // 1. client email
  if (!offer.client_email) {
    problem({ step: "email", message: "client_email is not set on this offer. Update it first." })
  }

  // 2. the yearly fee is written down. Which services carry a yearly fee comes from the service catalog (has_annual).
  let packages: unknown = null
  if (!stopped()) {
    const { data: annualRows, error: annualErr } = await supabaseAdmin.from("service_catalog").select("pipeline").eq("has_annual", true)
    const { data: pk, error: pkErr } = await supabaseAdmin
      .from("offers")
      // eslint-disable-next-line no-restricted-syntax -- packages postdates generated types (migration 20260826-1800)
      .select("packages" as never)
      .eq("token", offer.token)
      .maybeSingle()
    packages = (pk as unknown as { packages?: unknown } | null)?.packages ?? null
    if (annualErr) {
      problem({ step: "yearly_fee", couldNotCheck: true, message: `could not check whether this offer needs a yearly fee (${annualErr.message}) — try again.` })
    } else if (pkErr) {
      problem({ step: "yearly_fee", couldNotCheck: true, message: `could not read the offer's packages (${pkErr.message}) — try again.` })
    } else {
      const annualPipelines = (annualRows ?? []).map((r) => r.pipeline).filter((x): x is string => !!x)
      const reason = yearlyFeeMissingReason({
        services: offer.services,
        annualPipelines,
        recurringCosts: offer.recurring_costs,
        packages,
        currency: offer.installment_currency,
      })
      if (reason) problem({ step: "yearly_fee", message: reason })
    }
  }

  // 3. still a draft
  if (!stopped() && offer.status !== "draft") {
    problem({ step: "status", message: `offer is in '${offer.status}' status. Only 'draft' offers can be published.` })
  }

  // 4. every NEW service on the offer is ready to be sold (in the catalog, switched on, has steps, has an approved contract)
  if (!stopped()) {
    const readiness = await offerServicesReadiness({
      services: offer.services,
      bundledPipelines: offer.bundled_pipelines,
      packages,
      contractType: offer.contract_type ?? null,
    })
    if (readiness.problem) {
      const lookupOnly = readiness.blockers.length > 0 && readiness.blockers.every((b) => b.kind === "lookup")
      problem({ step: "services", message: readiness.problem, readiness: readiness.blockers, couldNotCheck: lookupOnly })
    }
  }

  // 5. the approved wording of every new service's contract can be frozen onto the offer. On the real send this WRITES (a fresh
  //    copy); the preview works it out in memory and writes nothing.
  if (!stopped()) {
    const opts: EnsureOptions = preview ? { refresh: true, persist: false } : { refresh: true }
    try {
      const frozen = await ensureOfferContractTexts(offer.token, opts)
      if (frozen.missing.length > 0) {
        problem({ step: "wording", message: `no approved contract wording for ${frozen.missing.join(", ")} — approve the service's contract in the Service Catalog first.` })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      problem({
        step: "wording",
        couldNotCheck: true,
        message: preview ? `could not read the contract wording (${msg}) — try again.` : `could not save the contract wording on the offer (${msg}) — try again.`,
      })
    }
  }

  if (preview) {
    // Never checked here, said out loud so a clean list is never read as "everything is fine".
    out.notChecked.push("The client's portal login is created at the moment you send, so it cannot be checked in advance.")
    if (typeof offer.services === "string") {
      out.notChecked.push("The services on this offer are stored as text, so none of them could be checked.")
    } else {
      const nameOnly = nameOnlyServiceLines(offer.services)
      if (nameOnly.length > 0) {
        out.notChecked.push(
          `${nameOnly.map((n) => `"${n}"`).join(", ")} ${nameOnly.length > 1 ? "were" : "was"} saved with a name only (no job), so the system cannot tell whether ${nameOnly.length > 1 ? "they have" : "it has"} steps or a contract.`,
        )
      }
    }
    // Billed services the client's contract would not contain: a warning, never a block (Antonio, 2026-10-26).
    try {
      const multi = await multiAgreementsEnabled()
      out.risks.push(...agreementCoverageWarnings(agreementCoverageGap({ services: offer.services }, offer.contract_type, multi)))
    } catch {
      out.notChecked.push("Whether every billed service appears in the client's contract could not be checked.")
    }
  }

  return out
}
