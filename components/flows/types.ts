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
  /** Resolved client label for the current stage, if any. */
  current_client_label?: string | null
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
}
