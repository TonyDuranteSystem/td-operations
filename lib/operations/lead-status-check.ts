/**
 * Shared decision for the "Lead status" check used by BOTH
 * diagnose-contact and diagnose-account (and, through diagnose-account, the
 * Portal Chats Issues panel). A lead auto-created for someone who already
 * had a client relationship (tagged with `existing_client_contact_id` at
 * creation time — see lib/calendly/existing-client-tag.ts) is not a stale
 * sales opportunity: it must not be flagged, and "Set to Converted" must
 * never be offered for it (that would falsely mark a never-paid lead as
 * paid — R094). Deliberately keyed on `existing_client_contact_id`, NOT
 * `converted_to_contact_id` — the latter means "this lead's real, actual
 * conversion" and is load-bearing for other flows; conflating the two would
 * make a genuinely converted lead's warning-clearing logic depend on the
 * wrong signal.
 */

export interface LeadStatusInput {
  status: string | null
  existing_client_contact_id: string | null
}

export function isUnresolvedLeadWarning(lead: LeadStatusInput): boolean {
  return lead.status !== "Converted" && !lead.existing_client_contact_id
}
