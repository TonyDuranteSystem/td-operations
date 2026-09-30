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
 *  - Scope follows where the offer was made (workspace-only plan S1, Antonio
 *    2026-09-27): made on a company page → that company; made on a lead or
 *    contact page → the person, never a guessed company. One exception: a
 *    person-level type (tag `contact_eligible`, e.g. Company Closure) bundled
 *    in a contract that forms or onboards a company stays on the person — the
 *    company being CLOSED is the client's OLD LLC, never the one on the contract.
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
import { getStartAtActivationServiceTypes, getContactEligibleServiceTypes, getRepeatableServiceTypes, LLC_MANAGEMENT_BUNDLE_TYPES } from "@/lib/services"

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
  // An offer that names no services at all is a legacy formation (safe default).
  if (bundled.length === 0 && typedLines.length === 0) return false
  // Otherwise THE OFFER'S SERVICE LIST decides (Antonio 2026-09-27): it is a
  // formation only if it sells Company Formation. Lines without a service type
  // are catalog add-ons (Public Notary, Shipping, Consulting…) and never make
  // an offer a formation — checked against every production formation offer.
  return !contractBoughtService({
    services: p.services,
    selectedServices: p.selectedServices,
    bundledPipelines: p.bundledPipelines,
    serviceType: "Company Formation",
  })
}

/**
 * Pure: the description of the invoice staff create with "Confirm Payment".
 * A formation-type contract that sold no formation (a name change, a closure)
 * is named after what was bought — "Company Change Name - X", never
 * "formation - X" (the client sees this line in their payment history).
 * Every other contract keeps the historical "<contract type> - X" wording.
 */
export function confirmedPaymentInvoiceLabel(p: {
  contractType: string
  clientName: string
  services: unknown
  selectedServices: unknown
  bundledPipelines: unknown
}): string {
  const suffix = `${p.clientName} (admin confirmed)`
  if (!isFormationContractWithoutFormation({ contractType: p.contractType, services: p.services, selectedServices: p.selectedServices, bundledPipelines: p.bundledPipelines })) {
    return `${p.contractType} - ${suffix}`
  }
  const selected = Array.isArray(p.selectedServices) ? (p.selectedServices as unknown[]).filter((x): x is string => typeof x === "string") : []
  const names = (Array.isArray(p.services) ? (p.services as Array<Record<string, unknown> | null>) : [])
    .filter((l): l is Record<string, unknown> => !!l && typeof l === "object" && typeof l.name === "string" && (l.name as string).trim() !== "")
    .filter((l) => selected.length === 0 || !l.optional || selected.includes(l.name as string))
    .map((l) => (l.name as string).trim())
  const label = names.length > 0 ? Array.from(new Set(names)).join(" + ")
    : (Array.isArray(p.bundledPipelines) ? (p.bundledPipelines as unknown[]).filter((b): b is string => typeof b === "string" && b.trim() !== "").join(" + ") : "")
  return `${label || "Services"} - ${suffix}`
}

export type StartServiceScope =
  | { kind: "contact" }
  | { kind: "account"; accountId: string }
  | { kind: "skip"; reason: string }
  /** A company service sold with a NEW company: it waits and is created on
   *  that company when the formation creates it (createCompanyServicesOnFormation). */
  | { kind: "wait" }

/** Pure: where a start-at-payment service is created (see header). */
export function decideStartServiceScope(p: {
  serviceType: string
  contactScopedTypes: string[] | null
  accountId: string | null
  /** The contract sells a NEW company (a real formation) or onboards one. A
   *  person-level service bundled there (Company Closure) is about the client's
   *  OLD company, never the one on the contract (plan §1.4). */
  newCompanyContract?: boolean
  /** The contract forms a NEW company (a real formation): company-level
   *  services wait for it (Antonio 2026-09-28 — a DBA / Incumbency of a company
   *  that does not exist yet cannot go on the person or on another company). */
  waitForNewCompany?: boolean
}): StartServiceScope {
  // null = catalog scope unknown → legacy behaviour (contact-scoped), which is
  // what every start-at-payment service did before S1.
  if (p.contactScopedTypes === null) return { kind: "contact" }
  const personLevel = p.contactScopedTypes.includes(p.serviceType)
  if (personLevel && p.newCompanyContract) return { kind: "contact" }
  if (!personLevel && p.waitForNewCompany) return { kind: "wait" }
  // Sold from a company page (Antonio 2026-09-27): a closure of THAT company, a
  // name change, a shipping… belongs to that company.
  if (p.accountId) return { kind: "account", accountId: p.accountId }
  // The offer lives where it was created (Antonio 2026-09-27): an offer made on
  // a lead or a contact page belongs to that person, so a company service sold
  // there is created on the PERSON — never skipped, never guessed onto one of
  // their companies. Staff connect it to a company in the workspace if needed.
  return { kind: "contact" }
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
  /** See decideStartServiceScope. */
  newCompanyContract?: boolean
  /** See decideStartServiceScope. */
  waitForNewCompany?: boolean
  /** Types tagged `repeatable`: each purchase is a new job — an open one of the
   *  same type does not block creation (only this offer's own does). */
  repeatableTypes?: string[]
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
        newCompanyContract: p.newCompanyContract ?? false,
        waitForNewCompany: p.waitForNewCompany ?? false,
      })
      if (scope.kind === "wait") {
        steps.push({ step: "start_at_activation", status: "waiting", detail: `${serviceType} waits for the new company — created when the formation creates it` })
        continue
      }
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
      // service: on that company. Skipped for repeatable services (a second
      // shipping/notary is a new job, not a duplicate).
      const repeatable = (p.repeatableTypes ?? []).includes(serviceType)
      let openFilter: string
      if (scope.kind === "account") {
        // Also an open one on the PERSON with no company (staff added it by hand
        // while it was waiting — bug-hunter 2026-09-29): never create a second.
        openFilter = p.contactId
          ? `account_id.eq.${scope.accountId},and(contact_id.eq.${p.contactId},account_id.is.null)`
          : `account_id.eq.${scope.accountId}`
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
      const { data: open, error: openErr } = repeatable
        ? { data: [] as Array<{ id: string; status: string; account_id: string | null }>, error: null }
        : await supabase
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

/** Banking is self-service until the bank workspace (plan S8): never created at payment. */
const NEVER_STARTED_AT_PAYMENT = new Set(["banking fintech", "banking physical"])

/**
 * Pure: the start-at-payment types for a formation-type contract that sold no
 * formation — the catalog's start-at-payment types PLUS every pipeline the
 * offer itself sells (typed lines and its service list), minus banking.
 * Unit-tested in tests/unit/activation-start-services.test.ts.
 */
export function allBoughtStartTypes(startTypes: string[], services: unknown, bundledPipelines: unknown): string[] {
  const out = new Map<string, string>()
  const add = (v: unknown) => {
    const t = typeof v === "string" ? v.trim() : ""
    if (!t || NEVER_STARTED_AT_PAYMENT.has(t.toLowerCase())) return
    if (!out.has(t.toLowerCase())) out.set(t.toLowerCase(), t)
  }
  startTypes.forEach(add)
  if (Array.isArray(services)) for (const l of services as Array<Record<string, unknown> | null>) if (l && typeof l === "object") add(l.pipeline_type)
  if (Array.isArray(bundledPipelines)) (bundledPipelines as unknown[]).forEach(add)
  return Array.from(out.values())
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
  /** The contract sells a new company or onboards one (see decideStartServiceScope). */
  newCompanyContract?: boolean
  /** A formation-type contract that sold NO formation: every bought service
   *  with a pipeline starts now (EIN, DBA, CMRA… sold alone created nothing
   *  before — S1 QA 2026-09-27), except banking (self-service until plan S8). */
  createAllBought?: boolean
  /** The contract forms a NEW company: company-level services wait for it. */
  waitForNewCompany?: boolean
}): Promise<ActivationStep[]> {
  const steps = await createBoughtStartAtActivationServicesInner(p)
  // Silent = nothing created AND nothing already reported (a skip/error step
  // has its own report — e.g. a name change with no company on the contract).
  if (p.mustCreateSomething && !steps.some((s) => ["created", "existing", "skipped", "error"].includes(s.status))) {
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
  newCompanyContract?: boolean
  createAllBought?: boolean
  waitForNewCompany?: boolean
}): Promise<ActivationStep[]> {
  const who = `${p.clientName || "unknown client"} (offer ${p.offerToken})`
  let startTypes: string[] = []
  try {
    startTypes = await getStartAtActivationServiceTypes()
    if (p.createAllBought) startTypes = allBoughtStartTypes(startTypes, p.offer?.services, p.offer?.bundled_pipelines)
  } catch (tagErr) {
    const detail = `catalog lookup failed: ${tagErr instanceof Error ? tagErr.message : String(tagErr)}`
    report(`start-at-payment services NOT checked for ${who}: ${detail}`, { offerToken: p.offerToken })
    return [{ step: "start_at_activation", status: "error", detail }]
  }
  if (startTypes.length === 0) return []

  let contactScopedTypes: string[]
  let repeatableTypes: string[] = []
  try {
    contactScopedTypes = await getContactEligibleServiceTypes()
    repeatableTypes = await getRepeatableServiceTypes()
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
    newCompanyContract: p.newCompanyContract ?? false,
    waitForNewCompany: p.waitForNewCompany ?? false,
    repeatableTypes,
  })
}

/**
 * Types a formation itself (or the yearly management it starts) already
 * delivers — never created again as a separate "company service".
 * Company Formation = the formation; EIN = obtained by the formation (SS-4);
 * the management bundle (CMRA, RA renewal, annual report, tax return) is
 * created when the formation closes / by the yearly engine, as today.
 */
const deliveredByFormation = (): string[] => [
  "company formation",
  // The onboarding creates its own Client Onboarding service (onboarding-setup).
  "client onboarding",
  "ein",
  ...LLC_MANAGEMENT_BUNDLE_TYPES.map((t) => t.toLowerCase()),
]

/**
 * Pure: the company services bought on a formation offer that must start when
 * the NEW company exists (Antonio 2026-09-28: "it has to wait when the company
 * is formed"). A DBA sold with a formation cannot exist before its company;
 * nothing created it, so it was paid for and never started (S1 QA 2026-09-28,
 * re-confirmed 2026-09-29 on sandbox offer qa-s1b-b6-g1-2026).
 *
 * Bought = the same rule as the offer total (not an unticked optional). Left
 * out: what the formation delivers itself (above), person-level services
 * (contact_eligible — ITIN starts from the formation form; a Company Closure is
 * the client's OLD company, started at payment), and banking (self-service
 * until plan S8). Company-level start-at-payment services (Incumbency, Change
 * Name…) are INCLUDED: on a real formation they waited at payment
 * (decideStartServiceScope "wait"). startAtActivationTypes is kept for callers
 * but no longer excludes anything. Returns canonical names, deduplicated.
 */
export function companyServicesToStartOnFormation(p: {
  services: unknown
  selectedServices: unknown
  startAtActivationTypes: string[]
  contactScopedTypes: string[]
}): { pipelines: string[]; multiQuantity: string[] } {
  const skip = new Set<string>([
    ...deliveredByFormation(),
    ...Array.from(NEVER_STARTED_AT_PAYMENT),
    ...p.contactScopedTypes.map((t) => t.toLowerCase()),
  ])
  const services = Array.isArray(p.services) ? (p.services as Array<Record<string, unknown> | null>) : []
  const selected = Array.isArray(p.selectedServices) ? (p.selectedServices as unknown[]).map(String) : []
  const out = new Map<string, string>()
  const count = new Map<string, number>()
  const multi = new Set<string>()
  for (const l of services) {
    if (!l || typeof l !== "object") continue
    const type = typeof l.pipeline_type === "string" ? l.pipeline_type.trim() : ""
    if (!type || skip.has(type.toLowerCase())) continue
    const name = typeof l.name === "string" ? l.name : ""
    if (l.optional && !selected.includes(name)) continue
    const key = type.toLowerCase()
    if (!out.has(key)) out.set(key, type)
    count.set(key, (count.get(key) ?? 0) + 1)
    if ((typeof l.quantity === "number" && l.quantity > 1) || (count.get(key) ?? 0) > 1) multi.add(out.get(key) as string)
  }
  return { pipelines: Array.from(out.values()), multiQuantity: Array.from(multi) }
}

/**
 * When the formation creates the company: start the company services bought
 * on the same offer (see companyServicesToStartOnFormation), ON that company.
 * Idempotent (one per offer per type — createStartAtActivationSDs dedupes by
 * source_offer_token), never throws, every skip/error reported.
 */
export async function createCompanyServicesOnFormation(p: {
  offerToken: string
  accountId: string
  contactId: string | null
}): Promise<ActivationStep[]> {
  try {
    const { data: offer, error } = await supabase
      .from("offers")
      .select("services, selected_services, client_name")
      .eq("token", p.offerToken)
      .maybeSingle()
    if (error) throw new Error(`offer lookup failed: ${error.message}`)
    if (!offer) return [{ step: "company_services_on_formation", status: "skipped", detail: `offer ${p.offerToken} not found` }]
    const [startTypes, contactScopedTypes, repeatableTypes] = await Promise.all([
      getStartAtActivationServiceTypes(),
      getContactEligibleServiceTypes(),
      getRepeatableServiceTypes(),
    ])
    const pick = companyServicesToStartOnFormation({
      services: offer.services,
      selectedServices: offer.selected_services,
      startAtActivationTypes: startTypes,
      contactScopedTypes,
    })
    if (pick.pipelines.length === 0) return []
    const steps = await createStartAtActivationSDs({
      offerToken: p.offerToken,
      clientName: (offer.client_name as string | null) ?? null,
      contactId: p.contactId,
      selection: { pipelines: pick.pipelines, mismatches: [], multiQuantity: pick.multiQuantity },
      accountId: p.accountId,
      contactScopedTypes,
      newCompanyContract: false,
      repeatableTypes,
    })
    return steps.map((s) => ({ ...s, step: "company_services_on_formation" }))
  } catch (err) {
    const detail = `company services bought with the formation NOT started for offer ${p.offerToken}: ${err instanceof Error ? err.message : String(err)} — add them by hand`
    report(detail, { offerToken: p.offerToken, accountId: p.accountId })
    return [{ step: "company_services_on_formation", status: "error", detail }]
  }
}
