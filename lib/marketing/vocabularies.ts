/**
 * TD Marketing — the fixed value lists the database CHECK constraints enforce (pure).
 * Registered in lib/db-contract.ts so a value the code writes that the database would reject fails the gate.
 * Team status lives in team-status.ts (TEAM_STATUSES).
 */
export const COMMISSION_BASES = ["amount_paid", "net_of_fees"] as const
export type CommissionBasis = (typeof COMMISSION_BASES)[number]

/** marketing_team_members.member_role and marketing_invites.member_role */
export const MARKETING_MEMBER_ROLES = ["owner", "member"] as const

export const MARKETING_MEMBER_STATUSES = ["active", "paused", "removed"] as const

export const LEADGEN_EVENT_SOURCES = ["webhook", "reconcile"] as const
export const LEADGEN_EVENT_STATUSES = ["pending", "done", "failed", "gave_up"] as const

export const SALE_STATUSES = ["link_created", "paid", "refunded", "partly_refunded", "failed", "expired"] as const
