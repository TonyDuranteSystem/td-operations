import { NextRequest, NextResponse } from "next/server"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { supabaseAdmin } from "@/lib/supabase-admin"

export const dynamic = "force-dynamic"

/**
 * GET /api/inbox/whatsapp-new/account-contacts?accountId=
 *
 * Lists the people already linked to an account, so the "Contact of an
 * existing client" save flow can offer "attach to one of these" instead of
 * only "create a new person" — which is what silently duplicated Marinela
 * Marku into a second contact record on 2026-09-18 (dev job f331cd43): the
 * flow found her company correctly but had no way to attach to the person
 * who already existed there.
 */
export async function GET(request: NextRequest) {
  const denied = await requireStaffRoute()
  if (denied) return denied

  const accountId = request.nextUrl.searchParams.get("accountId")?.trim()
  if (!accountId) {
    return NextResponse.json({ error: "accountId is required" }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin
    .from("account_contacts")
    .select("contacts(id, full_name, phone)")
    .eq("account_id", accountId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  type Row = { contacts: { id: string; full_name: string | null; phone: string | null } | null }
  const contacts = ((data ?? []) as unknown as Row[])
    .map((r) => r.contacts)
    .filter((c): c is { id: string; full_name: string | null; phone: string | null } => !!c)
    .map((c) => ({ id: c.id, name: c.full_name?.trim() || "(unnamed)", phone: c.phone }))

  return NextResponse.json({ contacts })
}
