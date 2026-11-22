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
 * Body: { contact_id, dry_run?, mode?: "delete"|"merge", merge_into_contact_id?,
 *          wanted_email? (dry-run report: the email the person wants — decides which contact is suggested to stay),
 *          field_choices? ({ detail: "loser"|"winner" } for personal details that differ or are only on the removed contact),
 *          document_ids? (owner-less personal documents to give to the kept contact) }
 *
 * "blocking references" = NO ACTION FK rows, computed by contact_reference_report()
 * (migration 20260610-1740). Pattern mirrors delete-lead/route.ts.
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { canPerform } from "@/lib/permissions"
import { logAction } from "@/lib/mcp/action-log"
import { findAuthUsersByContactId, findAuthUsersByContactIds } from "@/lib/auth-admin-helpers"
import { getContactReferenceReport, plainMergeError } from "@/lib/operations/contact-reference"
import type { DryRunResult } from "@/lib/operations/destructive"

interface ReferenceReport {
  total_blocking: number
  breakdown: Record<string, number>
  /** the database's own count, before the storage-owner row is added */
  dbTotal: number
}

async function getReport(contactId: string): Promise<ReferenceReport> {
  // the two reads are independent: one slow call used to be followed by another
  const [base, owners] = await Promise.all([
    getContactReferenceReport(contactId),
    // A person's storage-owner record is a RESTRICT foreign key, which the database report did not count at first —
    // without this the preview said "clean orphan" and the delete then failed.
    supabaseAdmin.from("store_owners").select("id", { count: "exact", head: true }).eq("contact_id", contactId),
  ])
  if (owners.error) throw new Error(`storage-owner check failed: ${owners.error.message}`)
  const breakdown = { ...base.breakdown }
  let total = base.total_blocking
  const storeOwnerRows = owners.count ?? 0
  if (storeOwnerRows > 0) {
    breakdown.store_owners = storeOwnerRows
    total += storeOwnerRows
  }
  return { total_blocking: total, breakdown, dbTotal: base.total_blocking }
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
      wanted_email?: string
      field_choices?: Record<string, string>
      document_ids?: string[]
      /** what happens to the portal logins: "kept" | "removed" | "none" (slice 3) */
      login_choice?: string
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

    // For a merge both contacts' logins come from ONE scan of the users (it used to be one scan per call, four in all).
    const logins = mode === "merge" && merge_into_contact_id ? await findAuthUsersByContactIds([contact_id, merge_into_contact_id]) : null
    const [report, portalUsers] = await Promise.all([
      getReport(contact_id),
      logins ? Promise.resolve(logins.get(contact_id) ?? []) : findAuthUsersByContactId(contact_id),
    ])
    const actor = `dashboard:${user?.email?.split("@")[0] ?? "unknown"}`

    // ── Dry-run preview of a MERGE (the person picked the contact to keep) ───
    if (dry_run && mode === "merge") {
      const { buildMergePreview } = await import("@/lib/operations/contact-merge-preview")
      const winnerLoginCount = merge_into_contact_id ? logins?.get(merge_into_contact_id)?.length : undefined
      const previewPromise = buildMergePreview({ loserId: contact_id, winnerId: merge_into_contact_id ?? null, report, portalLoginCount: portalUsers.length, winnerLoginCount })
      // The side-by-side report (both people, details, documents, logins). Reads only — the dry run never writes.
      let mergeReport = null
      const reportPromise = merge_into_contact_id
        ? (await import("@/lib/operations/contact-merge-report")).buildMergeReport(contact_id, merge_into_contact_id, body.wanted_email ?? null, { removedRecords: report.dbTotal, users: logins ?? undefined })
        : Promise.resolve(null)
      const [preview, built] = await Promise.all([previewPromise, reportPromise])
      if (built) {
        if ("error" in built) return NextResponse.json({ error: built.error }, { status: 400 })
        mergeReport = built
      }
      return NextResponse.json({ ok: true, preview, report: mergeReport })
    }

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

      // CRM Store pilot: two people who BOTH have their own new-store storage cannot be merged yet.
      // The same checks the preview showed (both storages, the same person owning one company twice, an already-merged contact) run again
      // here, so a merge that the preview refused can never be forced by calling this route directly.
      const { buildMergePreview } = await import("@/lib/operations/contact-merge-preview")
      const checked = await buildMergePreview({ loserId: contact_id, winnerId: merge_into_contact_id, report, portalLoginCount: portalUsers.length, winnerLoginCount: logins?.get(merge_into_contact_id)?.length })
      if (checked.blocker) return NextResponse.json({ error: checked.blocker }, { status: 409 })

      // Personal details and owner-less documents: re-read here (never trust the screen). Identity details that differ need an
      // explicit choice; only documents the report really offers can be given to the kept contact.
      const { buildMergeReport } = await import("@/lib/operations/contact-merge-report")
      const { cleanChoices, unresolvedIdentityConflicts } = await import("@/lib/contacts/merge-details")
      const mergeReport = await buildMergeReport(contact_id, merge_into_contact_id, null, { removedRecords: report.dbTotal, users: logins ?? undefined })
      if ("error" in mergeReport) return NextResponse.json({ error: mergeReport.error }, { status: 400 })
      const choices = cleanChoices(mergeReport.details, body.field_choices)
      const missing = unresolvedIdentityConflicts(mergeReport.details, choices)
      if (missing.length > 0) {
        return NextResponse.json({ error: `The two contacts have different ${missing.map((m) => m.label.toLowerCase()).join(", ")}. Choose which one is right, then merge again — nothing was changed.` }, { status: 400 })
      }
      // What happens to the portal logins (slice 3): checked against the logins as they are right now, BEFORE anything changes.
      const { resolveLoginChoice } = await import("@/lib/contacts/merge-logins")
      const loginCheck = resolveLoginChoice(body.login_choice, mergeReport.removed.logins, mergeReport.kept.logins)
      if (!loginCheck.ok) return NextResponse.json({ error: loginCheck.error }, { status: 400 })
      const offered = new Set(mergeReport.documents.ownerless.map((d) => d.id))
      const documentIds = Array.from(new Set(Array.isArray(body.document_ids) ? body.document_ids : []))
      if (documentIds.some((id) => typeof id !== "string" || !offered.has(id))) {
        return NextResponse.json({ error: "One of the chosen documents is no longer a personal document without an owner. Reload the merge window and try again — nothing was changed." }, { status: 409 })
      }

      // The owner records that belong to the merged-away contact will point at the kept one: remember them to give them the kept name.
      const { memberRowsOf } = await import("@/lib/operations/contact-name-follow")
      const loserMemberIds = (await memberRowsOf(contact_id).catch(() => [])).map((m) => m.id)

      // The generated types come from PRODUCTION, which has the 3-argument function until migration 20261117-2000 is applied there;
      // the two new arguments are passed through a widened call type. Remove the cast once the types are regenerated after that migration.
      const mergeRpc = supabaseAdmin.rpc as unknown as (
        fn: "merge_contacts",
        args: { p_loser: string; p_winner: string; p_merged_by: string; p_field_choices: Record<string, string>; p_document_ids: string[] },
      ) => ReturnType<typeof supabaseAdmin.rpc>
      const { data: mergeResult, error: mergeErr } = await mergeRpc.call(supabaseAdmin, "merge_contacts", {
        p_loser: contact_id,
        p_winner: merge_into_contact_id,
        p_merged_by: actor,
        p_field_choices: choices,
        p_document_ids: documentIds,
      })
      if (mergeErr) {
        return NextResponse.json(
          { error: `Merge failed: ${mergeErr.message}` },
          { status: 500 },
        )
      }

      // Personal documents an owner shared with a team login belong to the owner: the shares table has no foreign key (on purpose), so the
      // merge function above skipped it. Give the removed contact's shares to the kept one, or the login would silently lose them.
      let sharesMoved = 0
      try {
        const { moveSharesToContact } = await import("@/lib/portal/team/personal-docs-server")
        sharesMoved = (await moveSharesToContact(contact_id, merge_into_contact_id, user?.email ?? null)).moved
      } catch (shareErr) {
        const detail = shareErr instanceof Error ? shareErr.message : String(shareErr)
        console.error("[delete-contact] could not move document shares", detail)
        logAction({ actor, action_type: "merge", table_name: "contacts", record_id: contact_id, summary: `Merge of "${contact.full_name}" into "${target.full_name}": team document sharing was NOT moved`, details: { detail, mergeResult } })
        return NextResponse.json({ error: `The merge ran, but the "share my personal documents" setting of "${contact.full_name}" could not be moved to "${target.full_name}". Nothing was deleted — tell support.` }, { status: 500 })
      }

      // The merge moves the loser's storage to the winner, but the name on the winner did not change, so nothing else would rename
      // the folder: make the surviving person's top folder carry the winner's name. Best-effort, never throws.
      const { syncPersonRootName } = await import("@/lib/crm-store/person-root-name")
      await syncPersonRootName(merge_into_contact_id)
      // ...and the owner records that came over carry the kept contact's name (so the company papers match the person).
      const { renameMemberRowsForContact } = await import("@/lib/operations/contact-name-follow")
      await renameMemberRowsForContact(merge_into_contact_id, { onlyIds: loserMemberIds, actor })

      // Never trust the merge silently: the merged-away contact must have NOTHING left pointing at it (its storage included).
      const left = await getReport(contact_id).catch(() => null)
      const { count: ownersLeft } = await supabaseAdmin.from("store_owners").select("id", { count: "exact", head: true }).eq("contact_id", contact_id)
      const leftTotal = (left?.total_blocking ?? 0) + (ownersLeft ?? 0)
      if (leftTotal > 0) {
        logAction({ actor, action_type: "merge", table_name: "contacts", record_id: contact_id, summary: `Merge of "${contact.full_name}" into "${target.full_name}" left ${leftTotal} record(s) behind`, details: { left: left?.breakdown, ownersLeft, mergeResult } })
        return NextResponse.json({ error: `The merge ran, but ${leftTotal} linked record(s) did not move to "${target.full_name}". Do not continue — tell support; nothing was deleted.` }, { status: 500 })
      }

      // The portal logins, as chosen in the merge window: the login that moves is re-pointed at the kept contact FIRST and read back,
      // and only then are the others deleted. A failed move deletes nothing (the login stays on the removed contact, which still works).
      const { applyLoginChoice, realMergeLoginDeps } = await import("@/lib/operations/merge-logins")
      const keptLogins = logins?.get(merge_into_contact_id) ?? []
      const loginResult = await applyLoginChoice(loginCheck.choice, portalUsers, keptLogins, merge_into_contact_id, await realMergeLoginDeps(merge_into_contact_id))
      const removedLogins = loginResult.deleted.length
      if (loginResult.error) {
        logAction({ actor, action_type: "merge", table_name: "contacts", record_id: contact_id, summary: `Merge of "${contact.full_name}" into "${target.full_name}": the login was NOT moved`, details: { loginResult, mergeResult } })
        return NextResponse.json({ error: `The merge ran, but the login could not be moved to "${target.full_name}" (${loginResult.error}). No login was deleted — tell support.` }, { status: 500 })
      }

      logAction({
        actor,
        action_type: "merge",
        table_name: "contacts",
        record_id: contact_id,
        summary: `Merged contact "${contact.full_name}" into "${target.full_name}"`,
        details: { loser: contact_id, winner: merge_into_contact_id, mergeResult, removedLogins, login_choice: loginCheck.choice, login_result: loginResult, field_choices: choices, document_ids: documentIds, document_shares_moved: sharesMoved },
      })

      return NextResponse.json({
        ok: true,
        merged: true,
        message: `Merged "${contact.full_name}" into "${target.full_name}"`,
        result: mergeResult,
        removed_logins: removedLogins,
        moved_login: loginResult.moved,
        login_delete_failed: loginResult.deleteFailed.length,
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

    // Deleting the last person who can open a company is refused while others on it carry "no portal access" (QA 21 Nov 2026).
    {
      const { companiesLeftWithOnlyMarkedPeople, REMOVAL_LEAVES_ONLY_MARKED_MESSAGE } = await import("@/lib/members/removal-guard")
      const blockedCompanies = await companiesLeftWithOnlyMarkedPeople(contact_id)
      if (blockedCompanies.length > 0) {
        return NextResponse.json({ error: REMOVAL_LEAVES_ONLY_MARKED_MESSAGE, accounts: blockedCompanies }, { status: 409 })
      }
    }

    // Storage check / Calendar: every company this person was linked to loses them — remember it BEFORE the row goes (never blocks).
    try {
      const { data: links } = await supabaseAdmin.from("account_contacts").select("account_id").eq("contact_id", contact_id)
      const { recordPersonLeaving } = await import("@/lib/crm-store/storage-check")
      for (const l of (links ?? []) as Array<{ account_id: string }>) {
        await recordPersonLeaving({ accountId: l.account_id, contactId: contact_id, personName: contact.full_name ?? null, actorId: user?.id ?? null, via: "delete-contact" })
      }
    } catch { /* the delete goes on */ }

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
    console.error("[delete-contact]", msg)
    // never show raw database text to staff
    return NextResponse.json({ error: plainMergeError(msg) }, { status: 500 })
  }
}
