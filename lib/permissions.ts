/**
 * Team Permission Layer — Phase E
 *
 * Controls which actions team members (Luca) vs admin (Antonio) can perform.
 * Checked at BOTH levels:
 *   - UI: buttons only render if canPerform returns true
 *   - API: routes return 403 if canPerform returns false
 *
 * Role source: Supabase Auth user_metadata.role or email check (see lib/auth.ts)
 */

import type { User } from "@supabase/supabase-js"
import { isAdmin } from "./auth"

// ─── Action types ───

export type AdminAction =
  | "confirm_payment"
  | "convert_lead"
  | "create_offer"
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
  | "test_setup"
  | "test_cleanup"
  | "team_management"

export type TeamAction =
  | "create_lead"
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

export type CrmAction = AdminAction | TeamAction

// ─── Team-allowed actions ───

const TEAM_ALLOWED: ReadonlySet<string> = new Set<TeamAction>([
  "create_lead",
  "advance_stage",
  "mark_task_done",
  "create_task",
  "edit_task",
  "log_call",
  "add_note",
  "upload_document",
  "send_chat",
  "view_data",
  "reassign_task",
  "update_lead_status",
])

// ─── Permission check ───

/**
 * Check if a user can perform a given CRM action.
 * - Admin: can do everything
 * - Team: can only do actions in TEAM_ALLOWED
 * - Client / unauthenticated: nothing
 */
export function canPerform(user: User | null, action: CrmAction): boolean {
  if (!user) return false
  if (isAdmin(user)) return true
  return TEAM_ALLOWED.has(action)
}

/**
 * Quick check: is this user admin? (convenience re-export for components
 * that only need the boolean without importing from auth.ts directly)
 */
export { isAdmin } from "./auth"
