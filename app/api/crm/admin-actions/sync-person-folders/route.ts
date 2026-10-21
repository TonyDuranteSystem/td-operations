/**
 * POST /api/crm/admin-actions/sync-person-folders   body: { apply?: boolean }
 *
 * Admin-gated sweep: every person's storage top folder must carry the contact's current name. Default is a dry run (lists the
 * mismatches); { apply: true } renames them. Safe to run again (idempotent).
 */
import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { canPerform } from "@/lib/permissions"
import { logAction } from "@/lib/mcp/action-log"
import { sweepPersonRootNames } from "@/lib/crm-store/person-root-name"

export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!canPerform(user, "delete_record")) return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  const body = (await request.json().catch(() => ({}))) as { apply?: boolean }
  const apply = body.apply === true
  try {
    const result = await sweepPersonRootNames(apply)
    if (apply) {
      logAction({
        actor: `dashboard:${user?.email?.split("@")[0] ?? "unknown"}`,
        action_type: "update",
        table_name: "store_folders",
        record_id: "person-root-sweep",
        summary: `Person storage folders brought in line with the contact names (${result.renamed} renamed)`,
        details: { mismatches: result.mismatches, failed: result.failed },
      })
    }
    return NextResponse.json({ ok: true, apply, ...result })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Sweep failed" }, { status: 500 })
  }
}
