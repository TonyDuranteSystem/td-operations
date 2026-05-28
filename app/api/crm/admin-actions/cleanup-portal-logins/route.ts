/**
 * POST /api/crm/admin-actions/cleanup-portal-logins
 *
 * Contact-scoped portal-login cleanup. A contact should have exactly ONE auth
 * login — the one matching its primary email. This removes stray logins (a
 * different email pointing at the same contact, e.g. an orphan created by an
 * offer that used a different address), keeping the canonical one.
 *
 * Body: { contact_id: string, dry_run?: boolean }
 *  - dry_run (default true): returns the plan without deleting (preview).
 *  - dry_run=false: deletes the strays via the GoTrue admin API, logs each.
 *
 * SAFETY: if no login matches the contact's primary email, deletes NOTHING and
 * returns a warning (never leave a contact with zero logins). Admin-only.
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { findAuthUsersByContactId } from "@/lib/auth-admin-helpers"
import { planLoginCleanup } from "@/lib/portal/login-cleanup"
import { canPerform } from "@/lib/permissions"
import { logAction } from "@/lib/mcp/action-log"

export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!canPerform(user, "delete_record")) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  }

  try {
    const { contact_id, dry_run = true } = (await request.json()) as {
      contact_id?: string
      dry_run?: boolean
    }
    if (!contact_id) {
      return NextResponse.json({ error: "contact_id required" }, { status: 400 })
    }

    const { data: contact } = await supabaseAdmin
      .from("contacts")
      .select("id, full_name, email")
      .eq("id", contact_id)
      .maybeSingle()
    if (!contact) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 })
    }

    const logins = await findAuthUsersByContactId(contact_id)
    const plan = planLoginCleanup(
      logins.map(u => ({ id: u.id, email: u.email ?? null })),
      contact.email ?? "",
    )

    const keepEmail = plan.keepId ? logins.find(u => u.id === plan.keepId)?.email ?? null : null
    const deleteList = plan.deleteIds.map(id => ({ id, email: logins.find(u => u.id === id)?.email ?? null }))

    // Preview only.
    if (dry_run) {
      return NextResponse.json({
        ok: true,
        dry_run: true,
        contact: { id: contact.id, name: contact.full_name, primary_email: contact.email },
        keep: plan.keepId ? { id: plan.keepId, email: keepEmail } : null,
        would_delete: deleteList,
        warning: plan.warning ?? null,
        message:
          deleteList.length === 0
            ? plan.warning ?? "No stray logins — nothing to clean."
            : `Would delete ${deleteList.length} stray login(s), keeping ${keepEmail}.`,
      })
    }

    // Execute deletions.
    const deleted: { id: string; email: string | null }[] = []
    const failed: { id: string; email: string | null; error: string }[] = []
    for (const target of deleteList) {
      const { error } = await supabaseAdmin.auth.admin.deleteUser(target.id)
      if (error) {
        failed.push({ ...target, error: error.message })
      } else {
        deleted.push(target)
      }
    }

    if (deleted.length > 0) {
      await logAction({
        actor: `dashboard:${user?.email?.split("@")[0] ?? "unknown"}`,
        action_type: "delete",
        table_name: "auth.users",
        record_id: contact_id,
        contact_id,
        summary: `Cleaned up ${deleted.length} stray portal login(s) for ${contact.full_name} (kept ${keepEmail})`,
        details: { contact_id, kept: { id: plan.keepId, email: keepEmail }, deleted, failed },
      })
    }

    return NextResponse.json({
      ok: failed.length === 0,
      dry_run: false,
      keep: plan.keepId ? { id: plan.keepId, email: keepEmail } : null,
      deleted,
      failed,
      warning: plan.warning ?? null,
      message:
        deleted.length === 0
          ? plan.warning ?? "No stray logins — nothing to clean."
          : `Deleted ${deleted.length} stray login(s), kept ${keepEmail}.${failed.length ? ` ${failed.length} failed.` : ""}`,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
