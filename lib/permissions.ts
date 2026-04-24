/**
 * Team Permission Layer — Phase E
 *
 * Controls which actions CRM users (admin + team) can perform.
 * Team members have the SAME permissions as admin for all CRM actions.
 * Only Dev Tools and Team Management pages remain admin-only (via middleware).
 *
 * Checked at BOTH levels:
 *   - UI: buttons only render if canPerform returns true
 *   - API: routes return 403 if canPerform returns false
 *
 * Role source: Supabase Auth user_metadata.role or email check (see lib/auth.ts)
 */

import type { User } from "@supabase/supabase-js"
import { isAdmin, isDashboardUser } from "./auth"

// ─── Action types ───

/** Actions that only admin can do (system-level) */
export type AdminAction =
  | "test_setup"
  | "test_cleanup"
  | "team_management"

/** Actions any CRM user (admin + team) can do */
export type TeamAction =
  | "confirm_payment"
  | "convert_lead"
  | "create_offer"
  | "create_lead"
  | "activate_lead"
  | "mark_lost"
  | "place_client"
  | "create_portal_login"
  | "change_portal_tier"
  | "generate_oa"
  | "generate_lease"
  | "generate_ss4"
  | "generate_welcome_package"
  | "send_document"
  | "create_invoice"
  | "void_invoice"
  | "mark_payment_paid"
  | "delete_record"
  | "advance_stage"
  | "mark_task_done"
  | "create_task"
  | "edit_task"
  | "log_call"
  | "add_note"
  | "upload_document"
  | "send_chat"
  | "view_data"
  | "reassign_task"
  | "update_lead_status"
  | "record_ein_received"

export type CrmAction = AdminAction | TeamAction

// ─── Admin-only actions (system/dev only) ───

const ADMIN_ONLY: ReadonlySet<string> = new Set<AdminAction>([
  "test_setup",
  "test_cleanup",
  "team_management",
])

// ─── Permission check ───

/**
 * Check if a user can perform a given CRM action.
 * - Admin: can do everything
 * - Team: can do everything EXCEPT admin-only system actions
 * - Client / unauthenticated: nothing
 */
export function canPerform(user: User | null, action: CrmAction): boolean {
  if (!user) return false
  if (isAdmin(user)) return true
  if (!isDashboardUser(user)) return false
  // Team can do everything except admin-only system actions
  return !ADMIN_ONLY.has(action)
}

/**
 * Quick check: is this user admin? (convenience re-export for components
 * that only need the boolean without importing from auth.ts directly)
 */
export { isAdmin } from "./auth"
