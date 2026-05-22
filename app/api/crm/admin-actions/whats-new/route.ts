/**
 * What's New (Notification Center) — handled state for incoming system notes.
 *
 * GET  ?counts=true  — per-account/contact count of UNHANDLED system notes
 *                      (sender_type='system', handled_at IS NULL). Drives the
 *                      PURPLE per-thread dot in portal-chats: present while
 *                      something new is untriaged, gone once all are handled.
 * POST { message_id, handled } — tick/untick a note as handled. Handling means
 *                      "I opened a card for it" or "I know what to do, no card".
 *                      Unticking clears it so the dot returns. Staff-only.
 *
 * Notes are STAFF-ONLY (system messages are filtered out of the client portal).
 * See sysdoc notification-center-plan.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { supabaseAdmin } from "@/lib/supabase-admin"

export const dynamic = "force-dynamic"

// handled_at/handled_by aren't in the generated Database types until the
// migration is promoted to prod + types regenerated. Loose handle (mirrors
// lib/notifications/act-event.ts). Remove after type regen.
// eslint-disable-next-line no-restricted-syntax -- temporary until prod type regen; see sysdoc notification-center-plan
const db = supabaseAdmin as unknown as SupabaseClient

export async function GET(req: NextRequest) {
  try {
    const wantCounts = req.nextUrl.searchParams.get("counts") === "true"
    if (!wantCounts) {
      return NextResponse.json({ error: "Unsupported query" }, { status: 400 })
    }
    // Unhandled system notes grouped by the thread they belong to.
    const { data, error } = await supabaseAdmin
      .from("portal_messages")
      .select("account_id, contact_id")
      .eq("sender_type", "system")
      .is("handled_at", null)
      .is("deleted_at", null)
      .limit(5000)
    if (error) throw error
    const by_account: Record<string, number> = {}
    const by_contact: Record<string, number> = {}
    for (const r of (data ?? []) as Array<{ account_id: string | null; contact_id: string | null }>) {
      if (r.account_id) by_account[r.account_id] = (by_account[r.account_id] ?? 0) + 1
      else if (r.contact_id) by_contact[r.contact_id] = (by_contact[r.contact_id] ?? 0) + 1
    }
    const total = Object.values(by_account).reduce((s, n) => s + n, 0) +
      Object.values(by_contact).reduce((s, n) => s + n, 0)
    return NextResponse.json({ by_account, by_contact, total })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    // Staff-only: this writes triage state.
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user || !isDashboardUser(user)) {
      return NextResponse.json({ error: "Not authorized" }, { status: 403 })
    }

    const { message_id, handled } = await req.json()
    if (!message_id || typeof handled !== "boolean") {
      return NextResponse.json({ error: "Missing message_id or handled" }, { status: 400 })
    }

    const meta = (user.user_metadata ?? {}) as Record<string, unknown>
    const name = (typeof meta.full_name === "string" && meta.full_name) || user.email || user.id

    const { error } = await db
      .from("portal_messages")
      .update(
        handled
          ? { handled_at: new Date().toISOString(), handled_by: name }
          : { handled_at: null, handled_by: null },
      )
      .eq("id", message_id)
      .eq("sender_type", "system") // only system notes carry handled state
    if (error) throw error
    return NextResponse.json({ ok: true, handled })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
