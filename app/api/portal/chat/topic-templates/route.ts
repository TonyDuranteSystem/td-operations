/**
 * GET /api/portal/chat/topic-templates
 *
 * Returns active topic_templates catalog rows, RBAC-filtered by the user's
 * CRM role. The client applies additional context-based filtering
 * (requires_all / requires_any) against the live ChatContext.
 *
 * Slice 7 first consumer: portal-chats "Open new topic" selector behind
 * NEXT_PUBLIC_CHAT_TOPIC_TEMPLATES_CATALOG=on.
 *
 * Auth: dashboard users only (admin or team).
 *
 * Response: { templates: TopicTemplate[] } — already RBAC-filtered.
 *           403 on auth failures; 500 with { error } on internal errors.
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getCrmRole, isDashboardUser } from "@/lib/auth"
import { isAllowed, listTopicTemplates } from "@/lib/chat/topic-templates"

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
    const all = await listTopicTemplates()
    const allowed = all.filter((t) => isAllowed(t, role))
    return NextResponse.json({ templates: allowed })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
