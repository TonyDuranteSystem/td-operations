/**
 * POST /api/crm/admin-actions/portal-user-delete-preview
 *
 * P3.7: dry-run companion for {@link ../delete-portal-user/route.ts}.
 * Shows the auth user metadata + any linked contact/accounts before the
 * operator confirms the portal login deletion.
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { findAuthUserByEmail } from "@/lib/auth-admin-helpers"
import { canPerform } from "@/lib/permissions"
import type { DryRunResult } from "@/lib/operations/destructive"

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

    const match = await findAuthUserByEmail(email)

    if (!match) {
      return NextResponse.json({ error: `No portal user found for ${email}` }, { status: 404 })
    }

    const { data: contact } = await supabaseAdmin
      .from("contacts")
      .select("id, full_name")
      .eq("email", email)
      .maybeSingle()

    let accountNames: string[] = []
    if (contact?.id) {
      const { data: links } = await supabaseAdmin
        .from("account_contacts")
        .select("accounts(company_name)")
        .eq("contact_id", contact.id)
      accountNames = (links ?? [])
        .map(l => (l.accounts as unknown as { company_name: string } | null)?.company_name)
        .filter((n): n is string => !!n)
    }

    const preview: DryRunResult = {
      affected: {
        auth_user: 1,
      },
      items: [
        {
          label: `Portal login: ${email}`,
          details: [contact?.full_name ?? "no contact record"],
        },
      ],
      warnings: [
        "The auth user will be deleted — the client can no longer log in with this email.",
        "Contact record and linked accounts are NOT deleted.",
      ],
      record_label: email,
    }

    if (accountNames.length > 0) {
      preview.items.push({
        label: `${accountNames.length} linked ${accountNames.length === 1 ? "company" : "companies"}`,
        details: accountNames,
      })
    }

    return NextResponse.json(preview)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
