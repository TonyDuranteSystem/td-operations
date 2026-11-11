/**
 * "When a step is reached" — which services can be waited on, and the words the client reads (dev job ae3c19db).
 *
 * A later part of a payment plan can be due WHEN A STEP OF A SERVICE IS REACHED (Antonio, 2026-11-11: "when the EIN arrives" = the
 * Company Formation job reaches "EIN Received"). The Calendar's "Invoices to raise" list reads the job's own step number; nothing
 * fires, nothing is sent (see lib/offers/payment-plan.ts).
 *
 * WHY ONLY SOME SERVICES: the Calendar finds the job that came from THIS offer through `service_deliveries.source_offer_token`. Not every
 * kind of job carries it. Production, jobs created in the 120 days before 2026-11-11: Company Formation 16 of 19, ITIN 11 of 19, Company
 * Closure 2 of 16, everything else 0. A step on a service whose job is not tied to the offer would sit grey for ever and look like a
 * working reminder — so the offer builder only lists services that are reliably tied. Add a service here ONLY after checking that
 * its job carries the offer token.
 *
 * Pure — no I/O (the step list itself is read by `loadStepOptions` in load.ts).
 */

/** Services whose job carries the offer it came from — the only ones a part can wait a step of. */
export const STEP_TRIGGER_SERVICE_TYPES: readonly string[] = ["Company Formation", "ITIN"]

/**
 * The sentence the client reads for a "step" part when the author does not write their own. It reads straight after "Part 2 of 2, due"
 * (the schedule's own joining rule is in `clientFacingPartLabel`), so it starts with a connective.
 */
export function defaultStepWording(serviceType: string, stage: string): string {
  const s = stage.trim().toLowerCase()
  if (serviceType === "Company Formation") {
    if (s === "ein received") return "after the EIN arrives"
    if (s === "articles received") return "after your company's Articles of Organization are received"
    if (s === "filed with state") return "after your company is filed with the state"
    if (s === "ss-4 sent to irs") return "after your EIN application is sent to the IRS"
  }
  return `after the "${stage.trim()}" step`
}

/** One step of a service, as the offer builder lists it. */
export interface StepOption {
  service_type: string
  stage_name: string
  stage_order: number
}

/** The steps the offer builder may offer, for the services bought in THIS offer (only the allowed ones), in step order. Pure. */
export function stepOptionsForServices(all: StepOption[], boughtServiceTypes: string[]): StepOption[] {
  const bought = new Set(boughtServiceTypes.map((t) => t.trim().toLowerCase()))
  return all
    .filter((o) => STEP_TRIGGER_SERVICE_TYPES.some((t) => t.toLowerCase() === o.service_type.toLowerCase()) && bought.has(o.service_type.toLowerCase()))
    .sort((a, b) => (a.service_type === b.service_type ? a.stage_order - b.stage_order : a.service_type.localeCompare(b.service_type)))
}
