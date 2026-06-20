/**
 * Shared prop shapes for flow Workspace components. The stage-renderer hands
 * every component the same serviceDelivery + account context; each component
 * uses what it needs.
 */

export interface WorkspaceServiceDelivery {
  id: string
  service_type: string
  stage: string | null
  stage_order: number | null
  status: string | null
  assigned_to: string | null
  due_date: string | null
  stage_entered_at: string | null
  account_id: string
  /** Client full_name for contact-scoped SDs (in-flight Company Formation, ITIN
   *  — no account yet). Null when the SD has an account. Surfaced as a "Contact"
   *  row in the Overview info panel. */
  contact_name?: string | null
  /** Resolved client label for the current stage, if any. */
  current_client_label?: string | null
  /** Company Formation only — the name_checks entry with status 'filed', if any.
   *  Drives the SOS external_link "already filed" state on "Filed with State". */
  formation_filed_name?: string | null
  /** Client-submitted shipping info (ITIN signed-package tracking). Null until
   *  the client fills it in on the portal Client Signing stage. */
  shipping_courier?: string | null
  shipping_tracking_number?: string | null
  shipping_submitted_at?: string | null
}

/**
 * A TD invoice (payments row) surfaced in a flow Workspace — currently the 2nd
 * installment shown on the Tax Return "Awaiting 2nd Payment" stage info panel.
 */
export interface WorkspaceInvoice {
  /** payments.id — used for the /api/invoices/[id]/pdf staff link. */
  id: string
  invoice_number: string | null
  /** Lifecycle: Draft / Sent / Paid / Cancelled. */
  invoice_status: string | null
  amount: number | null
  currency: string | null
  due_date: string | null
  paid_date: string | null
  is_paid: boolean
}

export interface WorkspaceAccount {
  id: string
  company_name: string | null
  /** Free-text state (e.g. "Wyoming" or "WY"); normalized by consumers that
   *  need it (Secretary of State link resolution). */
  state_of_formation: string | null
  /** Next annual-report deadline (date). Surfaced on the Closed stage summary. */
  annual_report_due_date: string | null
  /** Next registered-agent renewal date. Surfaced on the Closed stage summary. */
  ra_renewal_date: string | null
  /** Federal EIN once assigned (accounts.ein_number). Null until "EIN Received".
   *  Surfaced in the Overview so staff see the number right after entering it. */
  ein_number?: string | null
  /** Registered Agent address (free text). Shown in the Overview when set. */
  registered_agent_address?: string | null
  /** Business mailing address — resolved from the addresses FK, falling back to
   *  the account's physical_address. Shown in the Overview when set. */
  mailing_address?: string | null
}
