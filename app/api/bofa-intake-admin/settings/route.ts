/**
 * The two address lists shown on the Forms page's Bank-application card (Antonio 2026-11-02).
 *   GET /api/bofa-intake-admin/settings  — anyone who may use Forms sees where applications are submitted and who is told
 *   PUT /api/bofa-intake-admin/settings { submit_to, notify_to } — OWNER ONLY. Changing where passports and IDs are sent
 *                                         is Antonio's decision, so the people who merely work the Forms area can read it
 *                                         but not change it. Every change records who/when inside the value and emails the owner.
 * Under /api/bofa-intake-admin so the middleware's session gate covers it.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { canUseForms, isOwnerOnly, PRIMARY_OWNER_EMAIL } from "@/lib/auth"
import { loadBofaSettings, saveBofaSettings } from "@/lib/bofa-intake/settings"
import { escapeHtml } from "@/lib/bofa-intake/email"
import { sendHtmlEmail } from "@/lib/bofa-intake/notify"

async function formsUser() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user && canUseForms(user) ? user : null
}

export async function GET() {
  const user = await formsUser()
  if (!user) return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  const s = await loadBofaSettings()
  if (!s.readable) return NextResponse.json({ error: "Could not read the settings." }, { status: 500 })
  return NextResponse.json({
    can_edit: isOwnerOnly(user),
    submit_to: s.submitTo?.emails ?? [],
    submit_changed_by: s.submitTo?.changedBy ?? null,
    submit_changed_at: s.submitTo?.changedAt ?? null,
    notify_to: s.notifyTo,
    notify_changed_by: s.notifyToSetting?.changedBy ?? null,
    notify_changed_at: s.notifyToSetting?.changedAt ?? null,
  })
}

export async function PUT(req: NextRequest) {
  const user = await formsUser()
  if (!user) return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  if (!isOwnerOnly(user)) return NextResponse.json({ error: "Only the owner can change these addresses." }, { status: 403 })
  const body = await req.json().catch(() => ({}))
  const r = await saveBofaSettings({ submitTo: body.submit_to, notifyTo: body.notify_to, by: user.email ?? "owner" })
  if ("error" in r) return NextResponse.json({ error: r.error }, { status: 400 })

  if (r.changed.submitTo || r.changed.notifyTo) {
    // A record in the owner's own inbox of where applicants' passports now go. Best-effort: the change is already saved and logged.
    try {
      const list = (l: string[]) => (l.length ? l.map(escapeHtml).join(", ") : "(none)")
      await sendHtmlEmail({
        to: [PRIMARY_OWNER_EMAIL],
        subject: "Bank application addresses were changed",
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <h2 style="color:#1e3a5f;">Bank application addresses were changed</h2>
          <p>By <strong>${escapeHtml(user.email ?? "unknown")}</strong>.</p>
          <p>Applications are submitted to: <strong>${list(r.submitTo.emails)}</strong> (before: ${list(r.before.submitTo)})</p>
          <p>Told when one arrives: <strong>${list(r.notifyTo.emails)}</strong> (before: ${list(r.before.notifyTo)})</p>
          <p style="color:#666;font-size:12px;">If you did not expect this, change it back on the Forms page.</p></div>`,
      })
    } catch (e) {
      console.error("[bofa-intake] settings-change alert failed:", e)
    }
  }
  return NextResponse.json({
    ok: true,
    submit_to: r.submitTo.emails,
    notify_to: r.notifyTo.emails,
    submit_changed_by: r.submitTo.changedBy,
    submit_changed_at: r.submitTo.changedAt,
    notify_changed_by: r.notifyTo.changedBy,
    notify_changed_at: r.notifyTo.changedAt,
  })
}
