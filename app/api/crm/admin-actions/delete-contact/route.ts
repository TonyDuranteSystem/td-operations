/**
 * POST /api/crm/admin-actions/delete-contact
 *
 * Admin/team-gated (canPerform "delete_record"). Safely removes a CRM contact.
 *
 * A contact can be referenced by ~60 FK columns, so a blind DELETE would either
 * fail (NO ACTION FKs) or silently orphan data. This route splits the two cases:
 *
 *   - ORPHAN (0 blocking references): hard-delete. CASCADE/SET NULL FKs resolve
 *     themselves; the portal login(s) for the contact are removed; the row is
 *     deleted. This is the path for a true duplicate (e.g. Michele Cotti's
 *     leftover contact with zero references).
 *
 *   - HAS HISTORY (>0 blocking references): a hard delete is refused. The caller
 *     must MERGE the contact into the real one (mode:"merge" + merge_into_contact_id),
 *     which reassigns every reference to the winner via the merge_contacts()
 *     DB function and keeps the loser as an audit tombstone (merged_into set,
 *     email blanked). The loser's portal login is then removed.
 *
 * Body: { contact_id, dry_run?, mode?: "delete"|"merge", merge_into_contact_id? }
 *
 * "blocking references" = NO ACTION FK rows, computed by contact_reference_report()
 * (migration 20260610-1740). Pattern mirrors delete-lead/route.ts.
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { canPerform } from "@/lib/permissions"
import { logAction } from "@/lib/mcp/action-log"
import { findAuthUsersByContactId } from "@/lib/auth-admin-helpers"
import type { DryRunResult } from "@/lib/operations/destructive"

interface ReferenceReport {
  total_blocking: number
  breakdown: Record<string, number>
}

async function getReport(contactId: string): Promise<ReferenceReport> {
  const { data, error } = await supabaseAdmin.rpc("contact_reference_report", {
    p_contact_id: contactId,
  })
  if (error) throw new Error(`reference report failed: ${error.message}`)
  const r = (data ?? {}) as Partial<ReferenceReport>
  return { total_blocking: r.total_blocking ?? 0, breakdown: r.breakdown ?? {} }
}

export async function POST(request: Request) {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!canPerform(user, "delete_record")) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  }

  try {
    const body = (await request.json()) as {
      contact_id?: string
      dry_run?: boolean
      mode?: "delete" | "merge"
      merge_into_contact_id?: string
    }
    const { contact_id, dry_run, mode, merge_into_contact_id } = body

    if (!contact_id) {
      return NextResponse.json({ error: "Missing contact_id" }, { status: 400 })
    }

    const { data: contact } = await supabaseAdmin
      .from("contacts")
      .select("id, full_name, email")
      .eq("id", contact_id)
      .maybeSingle()

    if (!contact) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 })
    }

    const report = await getReport(contact_id)
    const portalUsers = await findAuthUsersByContactId(contact_id)
    const actor = `dashboard:${user?.email?.split("@")[0] ?? "unknown"}`

    // ── Dry-run preview (shown in ConfirmDestructiveDialog) ──────────────────
    if (dry_run) {
      const items = Object.entries(report.breakdown).map(([key, n]) => ({
        label: `${key}: ${n}`,
      }))
      if (portalUsers.length > 0) {
        items.unshift({
          label: `portal login${portalUsers.length > 1 ? "s" : ""}: ${portalUsers.length} (will be removed)`,
        })
      }
      const preview: DryRunResult = {
        affected: { references: report.total_blocking, portal_logins: portalUsers.length },
        items,
        record_label: contact.full_name || contact.email || contact_id,
        warnings:
          report.total_blocking > 0
            ? [
                `This contact has ${report.total_blocking} linked record(s) of history. It cannot be hard-deleted — merge it into the real contact instead.`,
              ]
            : ["No linked history — this is a clean orphan and can be safely deleted."],
        blocker:
          report.total_blocking > 0 && mode !== "merge"
            ? `Has ${report.total_blocking} linked record(s) — choose a contact to merge into.`
            : undefined,
      }
      return NextResponse.json({ ok: true, preview })
    }

    // ── MERGE path (contact has history) ─────────────────────────────────────
    if (mode === "merge") {
      if (!merge_into_contact_id) {
        return NextResponse.json(
          { error: "merge mode requires merge_into_contact_id" },
          { status: 400 },
        )
      }
      if (merge_into_contact_id === contact_id) {
        return NextResponse.json(
          { error: "Cannot merge a contact into itself" },
          { status: 400 },
        )
      }
      const { data: target } = await supabaseAdmin
        .from("contacts")
        .select("id, full_name")
        .eq("id", merge_into_contact_id)
        .maybeSingle()
      if (!target) {
        return NextResponse.json({ error: "Merge target contact not found" }, { status: 404 })
      }

      const { data: mergeResult, error: mergeErr } = await supabaseAdmin.rpc("merge_contacts", {
        p_loser: contact_id,
        p_winner: merge_into_contact_id,
        p_merged_by: actor,
      })
      if (mergeErr) {
        return NextResponse.json(
          { error: `Merge failed: ${mergeErr.message}` },
          { status: 500 },
        )
      }

      // Remove the loser's portal login(s) — its email is now blanked, the
      // winner keeps the real login.
      let removedLogins = 0
      for (const u of portalUsers) {
        const { error: delErr } = await supabaseAdmin.auth.admin.deleteUser(u.id)
        if (!delErr) removedLogins++
      }

      logAction({
        actor,
        action_type: "merge",
        table_name: "contacts",
        record_id: contact_id,
        summary: `Merged contact "${contact.full_name}" into "${target.full_name}"`,
        details: { loser: contact_id, winner: merge_into_contact_id, mergeResult, removedLogins },
      })

      return NextResponse.json({
        ok: true,
        merged: true,
        message: `Merged "${contact.full_name}" into "${target.full_name}"`,
        result: mergeResult,
        removed_logins: removedLogins,
      })
    }

    // ── DELETE path (orphan only) ────────────────────────────────────────────
    if (report.total_blocking > 0) {
      return NextResponse.json(
        {
          error: `Contact has ${report.total_blocking} linked record(s) of history — merge it into the real contact instead of deleting.`,
          breakdown: report.breakdown,
        },
        { status: 409 },
      )
    }

    // Remove portal login(s) first, then the row (CASCADE/SET NULL FKs self-resolve).
    let removedLogins = 0
    for (const u of portalUsers) {
      const { error: delErr } = await supabaseAdmin.auth.admin.deleteUser(u.id)
      if (!delErr) removedLogins++
    }

    const { error: deleteErr } = await supabaseAdmin.from("contacts").delete().eq("id", contact_id)
    if (deleteErr) {
      return NextResponse.json(
        { error: `Failed to delete contact: ${deleteErr.message}` },
        { status: 500 },
      )
    }

    logAction({
      actor,
      action_type: "delete",
      table_name: "contacts",
      record_id: contact_id,
      summary: `Deleted orphan contact "${contact.full_name}" (${contact.email ?? "no email"})`,
      details: { contact_id, removed_logins: removedLogins },
    })

    return NextResponse.json({
      ok: true,
      deleted: true,
      message: `Deleted ${contact.full_name}`,
      removed_logins: removedLogins,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
