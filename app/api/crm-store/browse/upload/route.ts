/**
 * POST /api/crm-store/browse/upload — a staff upload into a NEW-store folder (company page / Storage tab).
 * Body: { ownerId, folderId, storagePath (onboarding-uploads), fileName, mimeType, documentType }.
 * Saves into the store + the CRM documents row (hidden from the client until staff share it).
 */
export const dynamic = "force-dynamic"
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { denyUnlessStoreStaff, denyUnlessStorePilotEnv, denyUnlessAreaAccess } from "../_auth"
import { plainStoreError } from "@/lib/crm-store/lock-errors"
import type { WaitingWorkspaceStep } from "@/lib/flows/storage-step-hints"

export async function POST(req: NextRequest) {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  const body = await req.json().catch(() => ({}))
  const { ownerId, folderId, storagePath, fileName, mimeType, documentType, personContactId, displayName, viaCompanyOwnerId } = body as Record<string, string | undefined>
  // hidden from the client unless the caller says so on purpose (Antonio 2026-10-13)
  const visible = (body as { visible?: unknown }).visible === true
  const extra = body as { periodYear?: unknown; filingAnswer?: unknown; needsReview?: unknown }
  const periodYear = typeof extra.periodYear === "number" && Number.isInteger(extra.periodYear) && extra.periodYear >= 1990 && extra.periodYear <= 2100 ? extra.periodYear : null
  const filingAnswer = extra.filingAnswer === "filed" || extra.filingAnswer === "draft" ? extra.filingAnswer : null
  const needsReview = typeof extra.needsReview === "string" && extra.needsReview.trim() ? extra.needsReview.trim().slice(0, 200) : null
  if (!ownerId || !folderId || !storagePath || !fileName) {
    return NextResponse.json({ error: "Choose a folder and a file." }, { status: 400 })
  }
  if (!documentType) {
    // only the firm's own areas (Business, My files) take a file without a document type; client storage needs one
    const { supabaseAdmin } = await import("@/lib/supabase-admin")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
    const { data: o } = await (supabaseAdmin as any).from("store_owners").select("kind").eq("id", ownerId).maybeSingle()
    const { isInternalOwnerKind } = await import("@/lib/crm-store/plain-drop")
    if (!isInternalOwnerKind(o?.kind)) return NextResponse.json({ error: "Choose a folder, a file and its document type." }, { status: 400 })
  }
  const noEnv = await denyUnlessStorePilotEnv({ ownerId, folderId })        // the pilot, or the firm's own areas anywhere
  if (noEnv) return noEnv
  const noAccess = (await denyUnlessAreaAccess({ ownerId, folderId })) ?? (viaCompanyOwnerId ? await denyUnlessAreaAccess({ ownerId: viaCompanyOwnerId }) : null)
  if (noAccess) return noAccess
  const { data: { user } } = await createClient().auth.getUser()

  // A file an open workspace step is waiting for must go through that step — or be filed in Storage on purpose (dev job e3215801: Adam
  // Mihaly's ITIN letter was filed here, hidden, while the workspace step that reads it, tells the client and closes the case never ran).
  // The Storage page asks the staff member first and sends `workspaceAck` (the cases they chose to leave); anything else is refused here.
  const ackBody = (body as { workspaceAck?: unknown }).workspaceAck
  const acked = Array.isArray(ackBody) ? ackBody.filter((x): x is string => typeof x === "string") : []
  const discardStaged = async () => {
    const { STAFF_STORE_UPLOAD_PREFIX } = await import("@/lib/crm-store/browse")
    if (!storagePath.startsWith(STAFF_STORE_UPLOAD_PREFIX) || storagePath.includes("..")) return
    const { supabaseAdmin } = await import("@/lib/supabase-admin")
    await supabaseAdmin.storage.from("onboarding-uploads").remove([storagePath]).catch(() => {})
  }
  let waiting: WaitingWorkspaceStep[] = []
  try {
    const { findWaitingWorkspaceSteps } = await import("@/lib/flows/storage-step-hints")
    waiting = await findWaitingWorkspaceSteps({ ownerId, folderId, documentType: documentType ?? null, personContactId: personContactId ?? null })
  } catch {
    await discardStaged()
    return NextResponse.json({ error: "Could not check whether a workspace is waiting for this file — nothing was saved. Please try again." }, { status: 503 })
  }
  const unanswered = waiting.filter((h) => acked.indexOf(h.sdId) === -1)
  if (unanswered.length > 0) {
    await discardStaged()
    const first = unanswered[0]
    return NextResponse.json(
      {
        code: "workspace_step_waiting",
        error: `${first.who}'s ${first.serviceType} case is at "${first.stage}" and is waiting for ${first.asks}. ${first.how ? `In the workspace: ${first.how} ` : ''}Or choose "Save in Storage only" in the Storage screen — nothing was saved.`,
        hits: unanswered,
      },
      { status: 409 },
    )
  }

  try {
    const { staffUploadToStore } = await import("@/lib/crm-store/browse")
    const r = await staffUploadToStore({ ownerId, folderId, storagePath, fileName, mimeType: mimeType ?? null, documentType: documentType ?? null, actorId: user?.id ?? null, personContactId: personContactId ?? null, displayName: displayName ?? null, visible, periodYear, filingAnswer, needsReview, viaCompanyOwnerId: viaCompanyOwnerId ?? null })
    // filed in Storage on purpose: say so on the case's record AND on the person's / company's own activity, so nobody has to guess later
    // why the step is still open. An identical re-save changed nothing, so it is not logged again. A note that cannot be written never
    // undoes the save — it is reported back (workspaceNote: "failed") so the staff member can note it by hand.
    let workspaceNote: "recorded" | "failed" | undefined
    if (waiting.length > 0 && r.write !== "unchanged") {
      workspaceNote = "recorded"
      const { supabaseAdmin } = await import("@/lib/supabase-admin")
      for (const h of waiting) {
        const asks = h.asks.charAt(0).toUpperCase() + h.asks.slice(1)
        const summary = h.matchedBy === "type"
          ? `${asks} filed in Storage only — ${h.who}'s ${h.serviceType} case is still at "${h.stage}" (the workspace step was not done)`
          : `A file typed "Other document" was filed in ${h.who}'s ${h.serviceType} folder while the case is at "${h.stage}" waiting for ${h.asks} (the workspace step was not done)`
        try {
          const { error } = await supabaseAdmin.from("action_log").insert({
            actor: `dashboard:${user?.email?.split("@")[0] ?? "unknown"}`,
            action_type: "storage_filed_workspace_document",
            table_name: "store_files",
            record_id: r.fileId,
            service_delivery_id: h.sdId,
            contact_id: h.contactId,
            account_id: h.accountId,
            summary,
            details: { file_name: r.name, stage: h.stage, workspace: h.workspacePath, document_type: documentType ?? null, matched_by: h.matchedBy },
          })
          if (error) throw new Error(error.message)
        } catch (e) {
          workspaceNote = "failed"
          console.error("[crm-store] could not record the Storage-only filing:", e instanceof Error ? e.message : e)
        }
      }
    }
    return NextResponse.json(workspaceNote ? { ...r, workspaceNote } : r)
  } catch (e) {
    return NextResponse.json({ error: plainStoreError(e, "The upload could not be saved.") }, { status: 400 })
  }
}
