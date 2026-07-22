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
 * `en` / `it` are the STANDALONE name (a tab, a chip, an activity line).
 *
 * `itOf` is the fragment that follows "il modulo …", and it exists because
 * Italian needs a preposition that English does not, and the right preposition
 * differs per label: "il modulo DI Costituzione" but "il modulo PER IL Conto
 * Bancario Payset". Building the sentence as "il modulo ${it}" produced
 * "Completa il modulo Costituzione" — wrong, and worse than the copy it
 * replaced. Both sentence frames below consume `itOf`, so the two cards on the
 * portal home can never disagree with each other again.
 *
 * VOCABULARY RULE: these strings must match what the rest of the product
 * already calls the thing (the services catalog, the guide, the wizard page).
 * An earlier version of this file invented "LLC Closure"/"Chiusura LLC" while
 * every other client-facing surface said "Company Closure"/"Chiusura Società" —
 * a vocabulary fork created by the very commit meant to end vocabulary forks.
 * Do not rename a service here. Rename it in the catalog, then follow.
 */
export const WIZARD_LABELS: Record<WizardType, { en: string; it: string; itOf: string }> = {
  // Italian follows the catalog exactly ("Onboarding LLC esistente" — onboarding
  // an EXISTING LLC, which is what the client actually bought). Shortening it to
  // "Onboarding" here was a fork; the catalog guard below caught it.
  onboarding: { en: "Onboarding", it: "Onboarding LLC esistente", itOf: "di Onboarding LLC esistente" },
  formation: { en: "LLC Formation", it: "Costituzione LLC", itOf: "di Costituzione LLC" },
  banking: { en: "Banking Setup", it: "Apertura Conto", itOf: "di Apertura Conto" },
  banking_payset: { en: "Payset Bank Account", it: "Conto Bancario Payset", itOf: "per il Conto Bancario Payset" },
  banking_relay: { en: "Relay Bank Account", it: "Conto Bancario Relay", itOf: "per il Conto Bancario Relay" },
  closure: { en: "Company Closure", it: "Chiusura Società", itOf: "di Chiusura Società" },
  itin: { en: "ITIN Application", it: "Richiesta ITIN", itOf: "ITIN" },
  tax: { en: "Tax Return", it: "Dichiarazione Fiscale", itOf: "di Dichiarazione Fiscale" },
  company_info: { en: "Company Information", it: "Informazioni Aziendali", itOf: "di Informazioni Aziendali" },
  td_communication: { en: "Brand Audit", it: "Brand Audit", itOf: "di Brand Audit" },
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
export function wizardLabelFor(wizardType: string): { en: string; it: string; itOf: string } {
  const resolved = LABEL_ALIASES[wizardType] ?? wizardType
  return WIZARD_LABELS[resolved as WizardType] ?? { en: wizardType, it: wizardType, itOf: wizardType }
}

/**
 * "Complete your Payset Bank Account form" — the phrasing the reminder email,
 * the push notification and the portal card all share, so a client who gets the
 * email and then opens the portal sees the same words for the same thing.
 */
export function completeWizardFormTitle(wizardType: string, lang: "en" | "it"): string {
  const label = wizardLabelFor(wizardType)
  return lang === "it"
    ? `Completa il modulo ${label.itOf}`
    : `Complete your ${label.en} form`
}

/**
 * The sibling card, for a form the client has not opened yet. It lives here
 * rather than inline at its call sites because the two cards render in the SAME
 * list: when this template and the one above drifted apart, an Italian client
 * saw "Completa il modulo Costituzione" directly above "Inizia il modulo di
 * Chiusura Società" — two grammars for the same kind of thing, side by side.
 */
export function startWizardFormTitle(wizardType: string, lang: "en" | "it"): string {
  const label = wizardLabelFor(wizardType)
  return lang === "it"
    ? `Inizia il modulo ${label.itOf}`
    : `Start your ${label.en} form`
}
