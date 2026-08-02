/**
 * Admin endpoint — the "back up all my email" control + progress.
 *
 * GET  → { enabled, mailboxes: [{ mailbox, total, complete, remaining, done }] }
 * POST → body { enabled: boolean } → turns the automatic off-hours backfill on/off.
 *
 * When enabled, the off-hours cron (/api/cron/email-content-backfill) walks the
 * history and stores every email's body + attachments by itself — no human step.
 * Admin-session auth (matches /api/admin/renewal-banner-year pattern).
 */
import { createClient } from "@/lib/supabase/server"
import { isAdmin } from "@/lib/auth"
import { NextRequest, NextResponse } from "next/server"
import { getAppSetting, setAppSetting } from "@/lib/settings"
import { backfillProgress } from "@/lib/email-store/auto-backfill"

const KEY = "email_content_backfill_enabled"

export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isAdmin(user)) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  }
  const [enabled, support, antonio] = await Promise.all([
    getAppSetting<boolean>(KEY, false),
    backfillProgress("support"),
    backfillProgress("antonio"),
  ])
  return NextResponse.json({ enabled: enabled === true, mailboxes: [support, antonio] })
}

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isAdmin(user)) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  }
  const body = (await req.json().catch(() => ({}))) as { enabled?: unknown }
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 })
  }
  await setAppSetting(KEY, body.enabled)
  return NextResponse.json({ ok: true, enabled: body.enabled })
}
