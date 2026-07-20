/**
 * Pure text-building helpers for the wizard-reminder cron
 * (app/api/cron/wizard-reminders/route.ts). Extracted so the reminder
 * copy is unit-testable without a DB connection.
 *
 * Two defects this closes (2026-07-20, Luma Beauty Global / THW Global
 * incident — Adam Mihaly owns both companies and got a reminder for THW's
 * unfinished Relay form while reading it inside Luma's portal chat):
 * - banking_relay / banking_payset had no label, so the reminder text
 *   leaked the internal wizard_type code ("Complete your banking_relay
 *   form") instead of a readable form name.
 * - the reminder never named the company it was about. A client who owns
 *   more than one company had no way to tell which company a reminder
 *   belonged to.
 */

export const WIZARD_LABELS: Record<string, { en: string; it: string }> = {
  formation: { en: "Formation", it: "Costituzione" },
  onboarding: { en: "Onboarding", it: "Onboarding" },
  tax: { en: "Tax Return", it: "Dichiarazione Fiscale" },
  tax_return: { en: "Tax Return", it: "Dichiarazione Fiscale" },
  itin: { en: "ITIN Application", it: "Richiesta ITIN" },
  banking: { en: "Banking Setup", it: "Apertura Conto" },
  banking_relay: { en: "Relay Bank Account", it: "Conto Bancario Relay" },
  banking_payset: { en: "Payset Bank Account", it: "Conto Bancario Payset" },
  closure: { en: "LLC Closure", it: "Chiusura LLC" },
}

/** Falls back to the raw wizard_type only for a type this map has never seen. */
export function wizardLabelFor(wizardType: string): { en: string; it: string } {
  return WIZARD_LABELS[wizardType] ?? { en: wizardType, it: wizardType }
}

/**
 * Builds the client-facing reminder title. Appends the company name when
 * known so a client with more than one company can tell which one a
 * reminder is about — the title is echoed verbatim by the push
 * notification, the portal activity feed, and the email digest, so fixing
 * it here fixes all three surfaces at once.
 */
export function buildWizardReminderTitle(params: {
  urgency: "3d" | "7d"
  wizardType: string
  companyName?: string | null
}): string {
  const label = wizardLabelFor(params.wizardType).en
  const prefix = params.urgency === "7d" ? "Action needed" : "Reminder"
  const suffix = params.companyName ? ` — ${params.companyName}` : ""
  return `${prefix}: Complete your ${label} form${suffix}`
}
