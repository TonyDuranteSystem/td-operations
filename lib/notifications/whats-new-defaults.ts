/**
 * Default "suggested next step" per What's New event — the text pre-filled when
 * staff click "Open card" on a What's New item. These are FALLBACKS: a per-event
 * override (catalog_entries.whats_new_events.metadata.suggested_step, editable in
 * Board Settings → What's New) wins when set. Keyed by event_key (chat-event kind,
 * or workflow slug for "started X" notes). Shared by the panel, the API, and the
 * settings editor so they never disagree. See sysdoc
 * notification-center-workflow-integration-plan.
 */
export const WHATS_NEW_DEFAULT_STEPS: Record<string, string> = {
  payment_received: 'Confirm what this payment was for and take the next step (e.g. ship card)',
  ss4_signed: 'Fax the SS-4 to the IRS to start the EIN application',
  document_uploaded: 'Review the document the client uploaded',
  itin_review: 'Review the ITIN submission (W-7 / 1040-NR)',
  banking_review_payset: 'Process / monitor the Payset banking application',
  banking_review_relay: 'Process / monitor the Relay banking application',
  banking_physical_progress: 'Handle the physical bank card step',
  tax_form_review: 'Review the tax submission',
  formation_progress: 'Verify the formation data + check the LLC name',
  onboarding_progress: 'Verify onboarding + RA change on Harbor',
  closure_progress: 'Begin the closure / dissolution steps',
  members_updated: 'Review the updated member details and reconcile the account',
  contact_updated: 'Review the contact details the client submitted',
  plan_referrer_ready_to_release: 'Open the account page and click "Release commission"',
  recurring_invoice_generated: 'Review the Draft invoice in Finance and send it to the client',
  card_autopay_enabled: 'No action needed — future invoices for this account will charge automatically',
}

/** Resolve the suggested next step for an event: catalog override → code default → ''. */
export function suggestedStepFor(eventKey: string | null, override?: string | null): string {
  if (override && override.trim()) return override
  if (eventKey && WHATS_NEW_DEFAULT_STEPS[eventKey]) return WHATS_NEW_DEFAULT_STEPS[eventKey]
  return ''
}
