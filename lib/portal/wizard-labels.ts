/**
 * THE client-facing name of every wizard, in both languages. Single source.
 *
 * ⛔ WHY THIS EXISTS — the same defect shipped twice.
 *
 * 2026-07-20 (Luma Beauty Global / THW Global): the reminder cron had no label
 * for banking_relay, so a client was emailed "Complete your banking_relay
 * form". Fixed — but only in the cron's own private map.
 *
 * 2026-07-21: the portal home was found leaking the identical way. Its title
 * was built by an inline ternary naming exactly two types:
 *
 *     const typeLabel = w.wizard_type === 'formation' ? 'Formation'
 *                     : w.wizard_type === 'onboarding' ? 'Onboarding'
 *                     : w.wizard_type          // ← every other type, raw
 *
 * Verified against production the same day, three real clients were reading
 * "Complete banking_payset Form" on their portal home: TFC Management LLC
 * (payset + relay), PTBT Holding LLC, LC Marketing Consulting LLC.
 *
 * There were FOUR independent label maps — the cron's, two inline ternaries in
 * queries.ts, and a switch pair also in queries.ts (which knew itin/closure but
 * not the banking types). Patching them one at a time is what produced the
 * second incident, so they now all resolve here.
 *
 * ── THE GUARANTEE ─────────────────────────────────────────────────────────────
 * WIZARD_LABELS is typed `Record<WizardType, …>`, keyed off VALID_WIZARD_TYPES.
 * Adding a wizard type without adding its label is a COMPILE ERROR, not a
 * client-visible internal code. That type annotation is the actual fix; the
 * strings are just data. Do not loosen it to `Record<string, …>`.
 */
import type { WizardType } from "./wizard-map"

/**
 * The client-facing name of each form, standalone. Used for a tab, an activity
 * line, and — via the builders below — the start of every action-card title.
 *
 * VOCABULARY RULE: these strings must match what the rest of the product
 * already calls the thing (the services catalog, the guide, the wizard page).
 * An earlier version of this file invented "LLC Closure"/"Chiusura LLC" while
 * every other client-facing surface said "Company Closure"/"Chiusura Società" —
 * a vocabulary fork created by the very commit meant to end vocabulary forks.
 * Do not rename a service here. Rename it in the catalog, then follow.
 */
export const WIZARD_LABELS: Record<WizardType, { en: string; it: string }> = {
  // Italian follows the catalog exactly ("Onboarding LLC esistente" — onboarding
  // an EXISTING LLC, which is what the client actually bought). Shortening it to
  // "Onboarding" here was a fork; the catalog guard below caught it.
  onboarding: { en: "Onboarding", it: "Onboarding LLC esistente" },
  formation: { en: "LLC Formation", it: "Costituzione LLC" },
  banking: { en: "Banking Setup", it: "Apertura Conto" },
  banking_payset: { en: "Payset Bank Account", it: "Conto Bancario Payset" },
  banking_relay: { en: "Relay Bank Account", it: "Conto Bancario Relay" },
  closure: { en: "Company Closure", it: "Chiusura Società" },
  itin: { en: "ITIN Application", it: "Richiesta ITIN" },
  tax: { en: "Tax Return", it: "Dichiarazione Fiscale" },
  company_info: { en: "Company Information", it: "Informazioni Aziendali" },
  td_communication: { en: "Brand Audit", it: "Brand Audit" },
}

/**
 * Some SERVICE types share a wizard but are not the same product, and the card
 * must say what the client actually bought. ITIN Renewal and ITIN Application
 * both open the `itin` wizard; naming both "ITIN Application" told a renewal
 * client to start an application, and disagreed with the wizard page they
 * landed on (which had its own hardcoded renewal label). Keyed by
 * service_deliveries.service_type.
 */
export const SERVICE_LABEL_OVERRIDES: Record<string, { en: string; it: string }> = {
  "ITIN Renewal": { en: "ITIN Renewal", it: "Rinnovo ITIN" },
}

/**
 * Offer contract types, for the CLIENT-VISIBLE journey feed. A separate
 * vocabulary from wizards — it lives here because this file is where the portal
 * keeps the names clients read, and scattering these is what caused the bug
 * twice already.
 *
 * The feed rendered these raw: "Offer created — tax_return", and "renewal" as
 * the sub-line under "Contract signed". Verified against production 2026-07-21:
 * renewal 162, formation 59, onboarding 14, tax_return 4, itin 1 — so the most
 * common offer in the business was showing clients an internal code.
 *
 * English only, deliberately: that whole feed is English for every event type,
 * which is a separate job.
 */
export const OFFER_TYPE_LABELS: Record<string, string> = {
  formation: "LLC Formation",
  onboarding: "Onboarding",
  tax_return: "Tax Return",
  itin: "ITIN Application",
  // "Annual Renewal" is the service-type name the codebase already uses.
  renewal: "Annual Renewal",
  banking: "Banking",
}

/** Falls back to nothing rather than to a raw code — the suffix is optional. */
export function offerTypeLabel(contractType: string | null | undefined): string | null {
  if (!contractType) return null
  return OFFER_TYPE_LABELS[contractType] ?? null
}

/**
 * Values that reach these helpers but are NOT wizard types. `tax_return` is the
 * service slug; it has leaked into wizard-shaped call sites and rendered raw.
 * Mapped rather than added to WIZARD_LABELS so the type stays exactly the set
 * of real wizard types.
 */
const LABEL_ALIASES: Record<string, WizardType> = {
  tax_return: "tax",
}

/**
 * Label for a wizard type. Falls back to the raw string ONLY for a value that
 * is neither a wizard type nor a known alias — i.e. data corruption. Every
 * legitimate value is covered by the compiler, so a fallback here means the
 * stored value is wrong, not that a label is missing.
 */
export function wizardLabelFor(wizardType: string, serviceType?: string | null): { en: string; it: string } {
  if (serviceType && SERVICE_LABEL_OVERRIDES[serviceType]) return SERVICE_LABEL_OVERRIDES[serviceType]
  const resolved = LABEL_ALIASES[wizardType] ?? wizardType
  return WIZARD_LABELS[resolved as WizardType] ?? { en: wizardType, it: wizardType }
}

/**
 * ⛔ THE NAME COMES FIRST. Do not reorder these.
 *
 * The card title is `truncate`d in a ~196px column on a 380px phone — and the
 * whole CRM/portal is used as a phone app. The first version read "Completa il
 * modulo per il Conto Bancario Payset", which clipped to "Completa il modulo
 * per il C…": a client holding both bank forms saw TWO CARDS THAT READ THE
 * SAME, with no way to tell Payset from Relay. Measured on the real page:
 * 322px of text in a 196px box.
 *
 * Leading with the label fixes that, and it also removed a whole class of bug —
 * the earlier shape put the label inside a prepositional phrase, so each label
 * had to carry its own Italian preposition ("di Costituzione" but "per il Conto
 * Bancario"). Getting one wrong shipped bad Italian. Here the name stands
 * alone, so there is no preposition to get wrong.
 *
 * Wording chosen by Antonio (2026-07-21): "Conto Bancario Payset — completa il
 * modulo".
 */
export function completeWizardFormTitle(
  wizardType: string,
  lang: "en" | "it",
  serviceType?: string | null,
): string {
  const label = wizardLabelFor(wizardType, serviceType)
  return lang === "it"
    ? `${label.it} — completa il modulo`
    : `${label.en} — complete your form`
}

/**
 * The sibling card, for a form the client has not opened yet. It lives beside
 * the one above because the two render in the SAME list: when the templates
 * drifted apart, an Italian client saw two different grammars stacked on top of
 * each other. Same name-first rule — see above.
 */
export function startWizardFormTitle(
  wizardType: string,
  lang: "en" | "it",
  serviceType?: string | null,
): string {
  const label = wizardLabelFor(wizardType, serviceType)
  return lang === "it"
    ? `${label.it} — inizia il modulo`
    : `${label.en} — start your form`
}
