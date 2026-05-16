/**
 * GET /api/portal/chat/quick-actions
 *
 * Returns the active chat_quick_actions catalog rows, filtered by the
 * current user's CRM role (RBAC enforced server-side as the source of
 * truth). The client applies an additional context-based filter
 * (requires_all/requires_any vs the live ChatContext).
 *
 * Slice 6a: foundation only. No client consumer yet. Slice 6b's page
 * refactor will call this endpoint via React Query.
 *
 * Auth: dashboard users only (admin or team).
 *
 * Response: { actions: QuickAction[] } — already RBAC-filtered.
 *           404/403 on auth failures; 500 with { error } on internal errors.
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getCrmRole, isDashboardUser } from "@/lib/auth"
import { isAllowed, listQuickActions } from "@/lib/chat/quick-actions"

export async function GET() {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: "Dashboard access required" }, { status: 403 })
  }

  const role = getCrmRole(user)
  if (!role) {
    return NextResponse.json({ error: "No CRM role" }, { status: 403 })
  }

  try {
    const all = await listQuickActions()
    const allowed = all.filter((a) => isAllowed(a, role))
    return NextResponse.json({ actions: allowed })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
