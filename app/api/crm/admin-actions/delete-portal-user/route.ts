/**
 * POST /api/crm/admin-actions/delete-portal-user
 *
 * Admin-only. Deletes a portal user (auth.users) by email.
 * Used when a portal user was created with wrong data or needs re-creation.
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { findAuthUserByEmail } from "@/lib/auth-admin-helpers"
import { canPerform } from "@/lib/permissions"
import { logAction } from "@/lib/mcp/action-log"

export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!canPerform(user, "delete_record")) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  }

  try {
    const { email } = await request.json()

    if (!email) {
      return NextResponse.json({ error: "Missing email" }, { status: 400 })
    }

    // Find auth user by email (paginated — P1.9)
    const match = await findAuthUserByEmail(email)

    if (!match) {
      return NextResponse.json({ error: `No portal user found for ${email}` }, { status: 404 })
    }

    const { error: deleteErr } = await supabaseAdmin.auth.admin.deleteUser(match.id)

    if (deleteErr) {
      return NextResponse.json(
        { error: `Failed to delete user: ${deleteErr.message}` },
        { status: 500 }
      )
    }

    logAction({
      actor: `dashboard:${user?.email?.split("@")[0] ?? "unknown"}`,
      action_type: "delete",
      table_name: "auth.users",
      record_id: match.id,
      summary: `Deleted portal user ${email} (auth id: ${match.id})`,
      details: {
        auth_user_id: match.id,
        email,
      },
    })

    return NextResponse.json({
      ok: true,
      message: `Deleted portal user ${email}`,
      auth_user_id: match.id,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
