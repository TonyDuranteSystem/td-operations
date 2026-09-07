import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { resolveAccountMembersForChat, pickAddressedToGuess } from "@/lib/portal/addressed-to"

export const dynamic = "force-dynamic"

/**
 * GET /api/portal/chat/members?account_id=X&reply_to_id=Y
 *
 * Real member roster + a pre-fill guess for the Portal Chats "Addressed to"
 * picker (dev job 08a8be62). Staff-only. Fetched fresh every time the picker
 * needs it — never cached client-side across a different account (the stale
 * cross-conversation bug this whole feature is careful to avoid).
 */
export async function GET(req: NextRequest) {
  const denied = await requireStaffRoute()
  if (denied) return denied

  const accountId = req.nextUrl.searchParams.get("account_id")
  const replyToId = req.nextUrl.searchParams.get("reply_to_id")
  if (!accountId) {
    return NextResponse.json({ error: "account_id is required" }, { status: 400 })
  }

  try {
    const options = await resolveAccountMembersForChat(accountId)

    let replyToContactId: string | null = null
    if (replyToId) {
      const { data: parent } = await supabaseAdmin
        .from("portal_messages")
        .select("contact_id, sender_type")
        .eq("id", replyToId)
        .maybeSingle()
      if (parent?.sender_type === "client" && parent.contact_id) {
        replyToContactId = parent.contact_id
      }
    }

    const { data: lastClient } = await supabaseAdmin
      .from("portal_messages")
      .select("contact_id")
      .eq("account_id", accountId)
      .eq("sender_type", "client")
      .not("contact_id", "is", null)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    const guess = pickAddressedToGuess({
      options,
      replyToContactId,
      lastClientContactId: lastClient?.contact_id ?? null,
    })

    return NextResponse.json({
      members: options,
      guessContactId: guess?.contactId ?? null,
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
