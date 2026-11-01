/**
 * PATCH /api/crm/leads/[id]/window/fields   body: { owner?: string | null, follow_up_date?: "YYYY-MM-DD" | null }
 *
 * The two fields the lead window edits in place (dev job 6fc63c52, phase D). Each goes through the same guarded
 * single-column write as the lead page edits: pass `expected_owner` / `expected_follow_up_date` (what the person
 * saw) and a change made by someone else meanwhile is a 409, never a silent overwrite. Staff only.
 */

import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { parseOwner, parseFollowUpDate } from "@/lib/leads/owners"
import { updateLeadColumnGuarded, hasExpectedValue, isGuardedFailure, type LeadDb } from "@/lib/leads/guarded-update"

export const dynamic = "force-dynamic"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  if (!UUID.test(params.id)) return NextResponse.json({ error: "That is not a valid lead id." }, { status: 400 })

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const changes: { column: string; value: string | null; expectedKey: string }[] = []
  if ("owner" in body) {
    const o = parseOwner(body.owner)
    if (!o.ok) return NextResponse.json({ error: o.message }, { status: 400 })
    changes.push({ column: "owner", value: o.value, expectedKey: "expected_owner" })
  }
  if ("follow_up_date" in body) {
    const f = parseFollowUpDate(body.follow_up_date)
    if (!f.ok) return NextResponse.json({ error: f.message }, { status: 400 })
    changes.push({ column: "follow_up_date", value: f.value, expectedKey: "expected_follow_up_date" })
  }
  if (changes.length === 0) return NextResponse.json({ error: "Nothing to change." }, { status: 400 })

  try {
    for (const c of changes) {
      const result = await updateLeadColumnGuarded(supabaseAdmin as unknown as LeadDb, {
        leadId: params.id, column: c.column, newValue: c.value, expected: body[c.expectedKey], hasExpected: hasExpectedValue(body, c.expectedKey),
      })
      if (isGuardedFailure(result)) {
        const status = result.reason === "conflict" ? 409 : result.reason === "not_found" ? 404 : 500
        return NextResponse.json({ error: result.message, conflict: result.reason === "conflict" }, { status })
      }
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("[leads/window/fields] unexpected error:", err)
    return NextResponse.json({ error: "Could not save — please try again." }, { status: 500 })
  }
}
