/**
 * Account status cascade definitions.
 * Pure data module — no DB access — so it can be shared between the
 * StatusChangeDialog (client) and unit tests. The actual cascade execution
 * lives in app/(dashboard)/accounts/actions.ts::changeAccountStatus.
 */

export type StatusCascadeKey =
  | 'blockNewServices'
  | 'suspendPortal'
  | 'cancelDeliveries'
  | 'cancelDeadlines'
  | 'createRACancelTask'
  | 'closeOpenTasks'
  | 'voidPendingPayments'
  | 'revokePortalAccess'
  | 'runClosureDocs'

export interface StatusCascadeAction {
  key: StatusCascadeKey
  label: string
  description: string
  defaultChecked: boolean
}

export const SUSPENDED_CASCADES: StatusCascadeAction[] = [
  {
    key: 'blockNewServices',
    label: 'Block new service deliveries',
    description:
      'Prevent sd_create from starting new services on this account until reactivated.',
    defaultChecked: true,
  },
  {
    key: 'suspendPortal',
    label: 'Suspend portal access (chat-only)',
    description:
      'Client sees a red banner, features disabled, only chat remains usable.',
    defaultChecked: true,
  },
]

export const CANCELLED_CASCADES: StatusCascadeAction[] = [
  {
    key: 'cancelDeliveries',
    label: 'Cancel active service deliveries',
    description:
      'Mark all active service_deliveries for this account as cancelled.',
    defaultChecked: true,
  },
  {
    key: 'cancelDeadlines',
    label: 'Cancel upcoming deadlines',
    description:
      'Mark Pending deadlines (RA Renewal, Annual Report, etc.) as Cancelled.',
    defaultChecked: true,
  },
  {
    key: 'createRACancelTask',
    label: 'Create HC RA cancellation task for Luca',
    description:
      'High-priority task: file Statement of Change with the state and notify Harbor Compliance.',
    defaultChecked: true,
  },
]

// Offboarding is a graceful-exit state. Behaviourally identical to Cancelled
// today — same 3 side effects — but distinguished in the UI so staff can tell
// a "client is leaving us on good terms" case apart from a "just cancelled"
// one. The lists can diverge later if the workflows differ.
export const OFFBOARDING_CASCADES: StatusCascadeAction[] = CANCELLED_CASCADES

export const CLOSED_CASCADES: StatusCascadeAction[] = [
  ...CANCELLED_CASCADES,
  {
    key: 'closeOpenTasks',
    label: 'Close all open tasks',
    description:
      'Mark all To Do / In Progress tasks for this account as cancelled.',
    defaultChecked: true,
  },
  {
    key: 'voidPendingPayments',
    label: 'Void pending / overdue payments',
    description:
      'Set payments with status Pending or Overdue to Cancelled. Paid invoices untouched.',
    defaultChecked: true,
  },
  {
    key: 'revokePortalAccess',
    label: 'Revoke portal access',
    description:
      'portal_tier = inactive and portal_account = false. Client can no longer log in for this LLC.',
    defaultChecked: true,
  },
  {
    key: 'runClosureDocs',
    label: 'Auto-generate dissolution documents',
    description:
      'Run closure_prepare_documents (Articles of Dissolution, EIN closure letter). Unchecked by default.',
    defaultChecked: false,
  },
]

/**
 * Returns the cascade actions that should appear in the dialog
 * when transitioning TO the given target status.
 * Returns an empty array for statuses that don't need cascades
 * (Active, Pending Formation, Delinquent).
 */
export function getCascadesForStatus(
  newStatus: string,
): StatusCascadeAction[] {
  switch (newStatus) {
    case 'Suspended':
      return SUSPENDED_CASCADES
    case 'Offboarding':
      return OFFBOARDING_CASCADES
    case 'Cancelled':
      return CANCELLED_CASCADES
    case 'Closed':
      return CLOSED_CASCADES
    default:
      return []
  }
}

/**
 * Build the default selections object (checkbox state) for a target status.
 */
export function getDefaultSelections(
  newStatus: string,
): Record<string, boolean> {
  const actions = getCascadesForStatus(newStatus)
  const out: Record<string, boolean> = {}
  for (const a of actions) out[a.key] = a.defaultChecked
  return out
}
