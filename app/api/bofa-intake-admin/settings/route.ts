/**
 * What the staff page's Submit confirm box needs: the address the reviewed application will be emailed to.
 *   GET /api/bofa-intake-admin/settings  — anyone who may use Forms (the confirm box shows this address, and the server
 *                                          refuses to send if it changed since the box was opened).
 * READ-ONLY on purpose. No form card and no screen shows or edits an email address (Antonio 2026-11-03); the stored
 * values (app_settings bofa_submit_to / bofa_notify_to) are changed by a developer, not from the CRM.
 * Under /api/bofa-intake-admin so the middleware's session gate covers it.
 */

export const dynamic = "force-dynamic"

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { canUseForms } from "@/lib/auth"
import { loadBofaSettings } from "@/lib/bofa-intake/settings"

export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !canUseForms(user)) return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  const s = await loadBofaSettings()
  if (!s.readable) return NextResponse.json({ error: "Could not read the settings." }, { status: 500 })
  return NextResponse.json({ submit_to: s.submitTo?.emails ?? [] })
}
