/**
 * E-sign envelopes of a service delivery — the shape the workspace panel shows, and the status words.
 * Pure and client-safe (the panel imports it).
 */
export interface EsignEnvelopeRow {
  id: string
  document_name: string
  status: string
  signed_count: number | null
  total_signers: number | null
  created_at: string
  completed_at: string | null
}

const STATUS_LABELS: Record<string, string> = {
  draft: 'Not sent yet',
  sent: 'Sent — waiting for the client',
  in_progress: 'Partly signed',
  completed: 'Signed',
  voided: 'Cancelled',
  expired: 'Expired',
}

/** Plain-English label of an envelope status (unknown statuses are shown as they are). */
export function esignStatusLabel(status: string | null | undefined): string {
  if (!status) return 'Unknown'
  return STATUS_LABELS[status] ?? status
}
