/**
 * Services that START AT PAYMENT for a formation contract (catalog tag
 * `start_at_activation` — today only Company Closure).
 *
 * Why (Antonio, 2026-09-24 — dev job 77b66080): activate-service's formation
 * branch creates ONLY the contact-scoped Company Formation SD. Every other
 * bundled service is left to a later hook (ITIN → wizard submit, RA / annual
 * report → crons, CMRA → lease by staff), but Company Closure had no hook at
 * all, so a paid "Formation + Closure" contract silently never got its closure
 * (Magyaródi Milan, magyardi-milan-2026). Closing the OLD LLC does not wait for
 * the new one, so the closure SD is created right at payment.
 *
 * Design rules (bug-hunter ×2 + system-counselor review of the plan):
 *  - "Bought" is recomputed from offer.services + selected_services with the
 *    SAME rule as the offer total (computeOfferTotals: `!optional ||
 *    selected.includes(name)`), never from bundled_pipelines alone — pruning at
 *    signing is fragile, and an unbought optional closure must never create an
 *    SD. pipeline_type is matched case-insensitively. Any disagreement between
 *    bundled_pipelines and the recomputed selection is REPORTED, never silently
 *    skipped.
 *  - Scope comes from the catalog (workspace-only plan S1, dev job 9d34e750):
 *    a type tagged `contact_eligible` (Company Closure) is contact-scoped
 *    (account_id NULL) — the company being CLOSED is the client's old LLC,
 *    never the one being formed. A type WITHOUT that tag (Company Change Name)
 *    belongs to an existing company and is created on the contract's company
 *    (offers.account_id); with no company on the contract it is NOT guessed —
 *    it is reported for staff to add by hand.
 *  - Runs for formation AND onboarding contracts (onboarding used to create
 *    nothing at payment, so a bundled closure was never created).
 *  - Never a duplicate: skip when (a) an SD of this type already carries this
 *    offer token in ANY status (a staff cancellation is respected on a retry),
 *    or (b) an active/on_hold SD of this type already exists for the contact or
 *    on any account linked to it (e.g. staff added it by hand). The DB index
 *    uq_closure_sd_active_per_offer backs (a) against concurrent runs.
 *  - Never silent: the activation is marked "activated" whatever the step
 *    results, so every skip/error is also sent to reportSystemError, with the
 *    client name + offer token in the MESSAGE (so each client gets its own
 *    report row instead of merging into one fingerprint).
 */

import { supabaseAdmin as supabase } from "@/lib/supabase-admin"
import { createSD } from "@/lib/operations/service-delivery"
import { reportSystemError } from "@/lib/system-errors"
import { getStartAtActivationServiceTypes, getContactEligibleServiceTypes } from "@/lib/services"

export interface ActivationStep {
  step: string
  status: string
  detail?: string
}

export interface StartAtActivationSelection {
  /** Canonical service types to create (e.g. "Company Closure"). */
  pipelines: string[]
  /** Human-readable disagreements to report (never silently dropped). */
  mismatches: string[]
  /** Types bought with quantity > 1 (only one SD is created — reported). */
  multiQuantity: string[]
}

/**
 * Pure: which start-at-activation services did the client actually buy?
 */
export function selectStartAtActivationPipelines(p: {
  services: unknown
  selectedServices: unknown
  bundledPipelines: unknown
  startAtActivationTypes: string[]
}): StartAtActivationSelection {
  const canon = (v: unknown): string | null => {
    const s = typeof v === "string" ? v.trim().toLowerCase() : ""
    if (!s) return null
    return p.startAtActivationTypes.find((t) => t.toLowerCase() === s) ?? null
  }
  const services = Array.isArray(p.services) ? (p.services as Array<Record<string, unknown>>) : []
  const selected = Array.isArray(p.selectedServices) ? (p.selectedServices as unknown[]).map(String) : []
  const bundled = new Set(
    (Array.isArray(p.bundledPipelines) ? (p.bundledPipelines as unknown[]) : [])
      .map(canon)
      .filter((x): x is string => !!x),
  )

  const bought = new Set<string>()
  const multiQuantity = new Set<string>()
  const linesPerType = new Map<string, number>()
  for (const svc of services) {
    if (!svc || typeof svc !== "object") continue
    const type = canon(svc.pipeline_type)
    if (!type) continue
    const name = typeof svc.name === "string" ? svc.name : ""
    const isSelected = !svc.optional || selected.includes(name)
    if (!isSelected) continue
    bought.add(type)
    // Two separate closure LINES (two old LLCs) count like quantity 2: only one
    // SD is created and the rest are reported — never silently dropped.
    linesPerType.set(type, (linesPerType.get(type) ?? 0) + 1)
    if ((typeof svc.quantity === "number" && svc.quantity > 1) || (linesPerType.get(type) ?? 0) > 1) multiQuantity.add(type)
  }

  const mismatches: string[] = []
  for (const t of Array.from(bundled)) {
    if (!bought.has(t)) {
      mismatches.push(`"${t}" is in the contract's service list but no bought line maps to it (deselected optional, or a line without pipeline_type) — not created`)
    }
  }
  for (const t of Array.from(bought)) {
    if (!bundled.has(t)) {
      mismatches.push(`"${t}" is a bought line but missing from the contract's service list — created anyway`)
    }
  }

  return { pipelines: Array.from(bought), mismatches, multiQuantity: Array.from(multiQuantity) }
}

function report(message: string, context: Record<string, unknown>) {
  reportSystemError({
    source: "server",
    route: "lib/operations/activation-start-services",
    message,
    context,
  }).catch(() => {})
}

/**
 * Pure: did this contract actually BUY `serviceType`? Same rule as the offer
 * total: a service line with that pipeline_type that is not an unticked
 * optional, OR the type listed in bundled_pipelines. Used to stop a
 * formation-type contract that sells only another service (DF Commerce: a
 * name change; SupraEmerge: a closure) from creating a fake Company Formation.
 */
export function contractBoughtService(p: {
  services: unknown
  selectedServices: unknown
  bundledPipelines: unknown
  serviceType: string
}): boolean {
  const target = p.serviceType.trim().toLowerCase()
  const bundled = Array.isArray(p.bundledPipelines) ? (p.bundledPipelines as unknown[]) : []
  if (bundled.some((b) => typeof b === "string" && b.trim().toLowerCase() === target)) return true
  const sel = selectStartAtActivationPipelines({
    services: p.services,
    selectedServices: p.selectedServices,
    bundledPipelines: [],
    startAtActivationTypes: [p.serviceType],
  })
  return sel.pipelines.length > 0
}

/**
 * Pure: is this a "formation" contract that CLEARLY sells something other than
 * a formation (it names services, and none of them is a formation)? Such a
 * contract must get none of the formation experience (no formation SD, tier,
 * wizard, welcome or label). A contract that names NO services at all is
 * ambiguous and is treated as a real formation (safe default — legacy / MCP
 * offers without a service list keep working exactly as before).
 */
export function isFormationContractWithoutFormation(p: {
  contractType: string | null | undefined
  services: unknown
  selectedServices: unknown
  bundledPipelines: unknown
}): boolean {
  if (p.contractType !== "formation") return false
  const bundled = Array.isArray(p.bundledPipelines) ? (p.bundledPipelines as unknown[]).filter((b) => typeof b === "string" && b.trim()) : []
  const typedLines = Array.isArray(p.services)
    ? (p.services as Array<Record<string, unknown> | null>).filter((l) => l && typeof l === "object" && typeof l.pipeline_type === "string" && (l.pipeline_type as string).trim())
    : []
  if (bundled.length === 0 && typedLines.length === 0) return false
  // A line with no pipeline_type can't be read (legacy / hand-made offers name
  // the formation "LLC Single Member — Florida" etc.) — when in doubt it IS a
  // formation, the legacy default. Only an offer whose every line is typed can
  // prove formation was not bought.
  const untypedLine = Array.isArray(p.services)
    && (p.services as Array<Record<string, unknown> | null>).some((l) => l && typeof l === "object" && !(typeof l.pipeline_type === "string" && (l.pipeline_type as string).trim()))
  if (untypedLine) return false
  return !contractBoughtService({
    services: p.services,
    selectedServices: p.selectedServices,
    bundledPipelines: p.bundledPipelines,
    serviceType: "Company Formation",
  })
}

export type StartServiceScope =
  | { kind: "contact" }
  | { kind: "account"; accountId: string }
  | { kind: "skip"; reason: string }

/** Pure: where a start-at-payment service is created (see header). */
export function decideStartServiceScope(p: {
  serviceType: string
  contactScopedTypes: string[] | null
  accountId: string | null
}): StartServiceScope {
  // null = catalog scope unknown → legacy behaviour (contact-scoped), which is
  // what every start-at-payment service did before S1.
  if (p.contactScopedTypes === null || p.contactScopedTypes.includes(p.serviceType)) return { kind: "contact" }
  if (p.accountId) return { kind: "account", accountId: p.accountId }
  return { kind: "skip", reason: `${p.serviceType} belongs to an existing company but the contract has no company linked` }
}

/**
 * Create the start-at-activation SDs for a paid formation / onboarding contract.
 * Never throws; returns one step row per decision.
 */
export async function createStartAtActivationSDs(p: {
  offerToken: string
  clientName: string | null
  contactId: string | null
  selection: StartAtActivationSelection
  /** The contract's company (offers.account_id) — used for company-scoped types. */
  accountId?: string | null
  /** Types tagged contact_eligible. Omitted/null → every type contact-scoped (pre-S1 behaviour). */
  contactScopedTypes?: string[] | null
}): Promise<ActivationStep[]> {
  const steps: ActivationStep[] = []
  const who = `${p.clientName || "unknown client"} (offer ${p.offerToken})`

  for (const m of p.selection.mismatches) {
    steps.push({ step: "start_at_activation", status: "skipped", detail: m })
    report(`[info] start-at-payment service check for ${who}: ${m}`, { offerToken: p.offerToken })
  }

  for (const serviceType of p.selection.pipelines) {
    try {
      const scope = decideStartServiceScope({
        serviceType,
        contactScopedTypes: p.contactScopedTypes ?? null,
        accountId: p.accountId ?? null,
      })
      if (scope.kind === "skip") {
        const detail = `${serviceType} not created for ${who}: ${scope.reason} — add it by hand`
        steps.push({ step: "start_at_activation", status: "skipped", detail })
        report(detail, { offerToken: p.offerToken, serviceType })
        continue
      }
      if (scope.kind === "contact" && !p.contactId) {
        const detail = `${serviceType} not created for ${who}: no contact linked to the offer — add it by hand`
        steps.push({ step: "start_at_activation", status: "skipped", detail })
        report(detail, { offerToken: p.offerToken, serviceType })
        continue
      }

      // (a) already created from THIS offer — any status (a staff cancellation is respected).
      const { data: byOffer, error: byOfferErr } = await supabase
        .from("service_deliveries")
        .select("id, status")
        .eq("service_type", serviceType)
        .eq("source_offer_token", p.offerToken)
        .limit(1)
      if (byOfferErr) throw new Error(`offer lookup failed: ${byOfferErr.message}`)
      if (byOffer && byOffer.length > 0) {
        steps.push({ step: "start_at_activation", status: "existing", detail: `${serviceType} already created from this offer (${byOffer[0].status}): ${byOffer[0].id}` })
        continue
      }

      // (b) an open one already exists (e.g. added by hand) — for a person-level
      // service: on the person or any of their companies; for a company
      // service: on that company.
      let openFilter: string
      if (scope.kind === "account") {
        openFilter = `account_id.eq.${scope.accountId}`
      } else {
        const { data: links, error: linksErr } = await supabase
          .from("account_contacts")
          .select("account_id")
          .eq("contact_id", p.contactId as string)
        if (linksErr) throw new Error(`account links lookup failed: ${linksErr.message}`)
        const accountIds = (links ?? []).map((l) => l.account_id as string).filter(Boolean)
        const parts = [`and(contact_id.eq.${p.contactId},account_id.is.null)`]
        if (accountIds.length) parts.push(`account_id.in.(${accountIds.join(",")})`)
        openFilter = parts.join(",")
      }
      const { data: open, error: openErr } = await supabase
        .from("service_deliveries")
        .select("id, status, account_id")
        .eq("service_type", serviceType)
        .in("status", ["active", "on_hold"])
        .or(openFilter)
        .limit(1)
      if (openErr) throw new Error(`open ${serviceType} lookup failed: ${openErr.message}`)
      if (open && open.length > 0) {
        const detail = `${serviceType} NOT created for ${who}: an open one already exists (${open[0].id}${open[0].account_id ? ", on a company" : ""}). If this contract is for a DIFFERENT company, add it by hand.`
        steps.push({ step: "start_at_activation", status: "existing", detail })
        report(`[info] ${detail}`, { offerToken: p.offerToken, serviceType, existingSdId: open[0].id })
        continue
      }

      try {
        const sd = await createSD({
          service_type: serviceType,
          service_name: p.clientName ? `${serviceType} - ${p.clientName}` : serviceType,
          contact_id: p.contactId,
          account_id: scope.kind === "account" ? scope.accountId : null,
          notes: `Auto-created from offer ${p.offerToken}`,
          source_offer_token: p.offerToken,
        })
        steps.push({
          step: "start_at_activation",
          status: "created",
          detail: `${serviceType} SD created (${scope.kind === "account" ? `on company ${scope.accountId}` : "contact-scoped"}): ${sd.id}`,
        })
        if (p.selection.multiQuantity.includes(serviceType)) {
          const detail = `${serviceType} bought with quantity > 1 by ${who}: only ONE was created — add the others by hand`
          steps.push({ step: "start_at_activation", status: "skipped", detail })
          report(detail, { offerToken: p.offerToken, serviceType })
        }
      } catch (createErr) {
        // A concurrent run may have won the unique index — re-check (a).
        const { data: winner } = await supabase
          .from("service_deliveries")
          .select("id")
          .eq("service_type", serviceType)
          .eq("source_offer_token", p.offerToken)
          .limit(1)
        if (winner && winner.length > 0) {
          steps.push({ step: "start_at_activation", status: "existing", detail: `${serviceType} already created (race-deduped): ${winner[0].id}` })
          continue
        }
        throw createErr
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const detail = `${serviceType} could NOT be created for ${who}: ${msg} — add it by hand`
      steps.push({ step: "start_at_activation", status: "error", detail })
      report(detail, { offerToken: p.offerToken, serviceType })
    }
  }

  return steps
}

/**
 * Catalog lookup + selection + creation in one call, for any contract whose
 * payment branch does not create every bundled service itself (formation and
 * onboarding). Never throws; lookup failures are reported, never silent.
 */
export async function createBoughtStartAtActivationServices(p: {
  offer: { services?: unknown; selected_services?: unknown; bundled_pipelines?: unknown; account_id?: string | null } | null | undefined
  offerToken: string
  clientName: string | null
  contactId: string | null
  /** The contract bought nothing else (a formation-template contract without a
   *  formation): if no service ends up created or already there, say so
   *  loudly instead of activating an empty contract (e.g. the catalog tag is
   *  missing in this environment). */
  mustCreateSomething?: boolean
}): Promise<ActivationStep[]> {
  const steps = await createBoughtStartAtActivationServicesInner(p)
  if (p.mustCreateSomething && !steps.some((s) => s.status === "created" || s.status === "existing")) {
    const detail = "this contract did not buy a formation and no other service was created from it — add the bought service by hand"
    report(`${detail}: ${p.clientName || "unknown client"} (offer ${p.offerToken})`, { offerToken: p.offerToken })
    steps.push({ step: "start_at_activation", status: "error", detail })
  }
  return steps
}

async function createBoughtStartAtActivationServicesInner(p: {
  offer: { services?: unknown; selected_services?: unknown; bundled_pipelines?: unknown; account_id?: string | null } | null | undefined
  offerToken: string
  clientName: string | null
  contactId: string | null
}): Promise<ActivationStep[]> {
  const who = `${p.clientName || "unknown client"} (offer ${p.offerToken})`
  let startTypes: string[] = []
  try {
    startTypes = await getStartAtActivationServiceTypes()
  } catch (tagErr) {
    const detail = `catalog lookup failed: ${tagErr instanceof Error ? tagErr.message : String(tagErr)}`
    report(`start-at-payment services NOT checked for ${who}: ${detail}`, { offerToken: p.offerToken })
    return [{ step: "start_at_activation", status: "error", detail }]
  }
  if (startTypes.length === 0) return []

  let contactScopedTypes: string[]
  try {
    contactScopedTypes = await getContactEligibleServiceTypes()
  } catch (tagErr) {
    // Unknown scope → create nothing rather than risk the wrong person/company.
    const detail = `scope lookup failed: ${tagErr instanceof Error ? tagErr.message : String(tagErr)}`
    report(`start-at-payment services NOT created for ${who}: ${detail} — add them by hand`, { offerToken: p.offerToken })
    return [{ step: "start_at_activation", status: "error", detail }]
  }

  const selection = selectStartAtActivationPipelines({
    services: p.offer?.services,
    selectedServices: p.offer?.selected_services,
    bundledPipelines: p.offer?.bundled_pipelines,
    startAtActivationTypes: startTypes,
  })
  return createStartAtActivationSDs({
    offerToken: p.offerToken,
    clientName: p.clientName,
    contactId: p.contactId,
    selection,
    accountId: p.offer?.account_id ?? null,
    contactScopedTypes,
  })
}
