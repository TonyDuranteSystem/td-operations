/**
 * Unified access code validation for all client-facing forms.
 *
 * Every form uses the same pattern: /form-name/[token]/[code]
 * The code is validated server-side against the DB before showing content.
 *
 * Mapping of form types to their DB tables:
 *   lease           → lease_agreements
 *   operating-agreement → oa_agreements
 *   offer           → offers
 *   formation-form  → formation_submissions
 *   onboarding-form → onboarding_submissions
 *   tax-form        → tax_return_submissions
 *   banking-form    → banking_submissions
 *   closure-form    → closure_submissions
 *
 * To add a new form: add an entry to FORM_TABLE_MAP below.
 */

export const FORM_TABLE_MAP: Record<string, string> = {
  lease: "lease_agreements",
  "operating-agreement": "oa_agreements",
  offer: "offers",
  "formation-form": "formation_submissions",
  "onboarding-form": "onboarding_submissions",
  "tax-form": "tax_return_submissions",
  "banking-form": "banking_submissions",
  "closure-form": "closure_submissions",
}
