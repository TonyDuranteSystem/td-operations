import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { supabaseAdmin } from "@/lib/supabase-admin"

export const dynamic = "force-dynamic"

/**
 * GET /api/inbox/client-scope-siblings?account_id=… | ?contact_id=…
 *
 * The OTHER scopes of the same client: for a company, its member contacts; for a
 * person, the companies they belong to.
 *
 * WHY THIS EXISTS. The portal Confirm card warns when the staff member picks a client
 * different from the one the worker wrote the message for, and blocks Confirm — the
 * guard added after a message opening "Hi Uxio" was delivered to a different client.
 * That guard compared ids, and a company id never equals its member's contact id, so
 * it also fired on the one case Antonio explicitly wanted available (2026-07-31: "If
 * Luca will choose company, the message will go to the company! If Luca will choose
 * the member of a company, it will go to the member"). It told him the message "was
 * written for Acme LLC, not Mario Rossi" — false — and locked the send.
 *
 * Choosing a different SCOPE of the same client is not a mismatch. Choosing a
 * different CLIENT is. Only the account↔contact links can tell the two apart.
 *
 * Read-only, staff-gated, and it returns ids only — never names or client data.
 */
export async function GET(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }

  const accountId = req.nextUrl.searchParams.get("account_id")?.trim()
  const contactId = req.nextUrl.searchParams.get("contact_id")?.trim()
  if (!accountId && !contactId) return NextResponse.json({ ids: [] })

  try {
    if (accountId) {
      const { data, error } = await supabaseAdmin
        .from("account_contacts")
        .select("contact_id")
        .eq("account_id", accountId)
      // supabase-js RETURNS errors rather than throwing, so destructuring `data`
      // alone swallows a permissions/schema failure into an empty list — which here
      // means "not the same client", locking Confirm on every legitimate member pick
      // with no log and no clue. Third instance of this same swallow in this codebase.
      if (error) throw new Error(error.message)
      const ids = ((data ?? []) as Array<{ contact_id: string | null }>)
        .map((r) => r.contact_id)
        .filter((v): v is string => !!v)
      return NextResponse.json({ ids })
    }
    const { data, error } = await supabaseAdmin
      .from("account_contacts")
      .select("account_id")
      .eq("contact_id", contactId as string)
    if (error) throw new Error(error.message)
    const ids = ((data ?? []) as Array<{ account_id: string | null }>)
      .map((r) => r.account_id)
      .filter((v): v is string => !!v)
    return NextResponse.json({ ids })
  } catch (err) {
    // Fails toward WARNING (empty list = treat a different id as a mismatch), which is
    // the safe direction: a spurious "rewrite it first" costs a round trip, a missed
    // warning sends a message naming the wrong client.
    console.warn("[client-scope-siblings] lookup failed:", err)
    return NextResponse.json({ ids: [] })
  }
}
