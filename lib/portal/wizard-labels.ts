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

export const WIZARD_LABELS: Record<WizardType, { en: string; it: string }> = {
  onboarding: { en: "Onboarding", it: "Onboarding" },
  formation: { en: "Formation", it: "Costituzione" },
  banking: { en: "Banking Setup", it: "Apertura Conto" },
  banking_payset: { en: "Payset Bank Account", it: "Conto Bancario Payset" },
  banking_relay: { en: "Relay Bank Account", it: "Conto Bancario Relay" },
  closure: { en: "LLC Closure", it: "Chiusura LLC" },
  itin: { en: "ITIN Application", it: "Richiesta ITIN" },
  tax: { en: "Tax Return", it: "Dichiarazione Fiscale" },
  company_info: { en: "Company Information", it: "Informazioni Aziendali" },
  td_communication: { en: "Brand Audit", it: "Brand Audit" },
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
export function wizardLabelFor(wizardType: string): { en: string; it: string } {
  const resolved = LABEL_ALIASES[wizardType] ?? wizardType
  return WIZARD_LABELS[resolved as WizardType] ?? { en: wizardType, it: wizardType }
}

/**
 * "Complete your Payset Bank Account form" — the phrasing the reminder email,
 * the push notification and the portal card all share, so a client who gets the
 * email and then opens the portal sees the same words for the same thing.
 */
export function completeWizardFormTitle(wizardType: string, lang: "en" | "it"): string {
  const label = wizardLabelFor(wizardType)
  return lang === "it"
    ? `Completa il modulo ${label.it}`
    : `Complete your ${label.en} form`
}
