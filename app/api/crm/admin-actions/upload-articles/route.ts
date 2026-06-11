/**
 * POST /api/crm/admin-actions/upload-articles
 *
 * Admin-only. Triggered by the "Upload Articles of Organization" button on
 * the LLC Name Selection card.
 *
 * Flow:
 *   1. Auth check (admin only).
 *   2. Read multipart form: file (PDF), contact_id, formation_date,
 *      filing_id?, registered_agent_id?
 *   3. Look up the contact's contact-level Drive folder + "1. Company"
 *      subfolder. Upload the file there with a clean filename.
 *   4. Insert a documents row for traceability (account_id=null at this
 *      point; the materialization step below will not retroactively
 *      backfill — the document stays linked to the contact AND the file
 *      itself moves into the company folder via Drive migration).
 *   5. Call materializeFormationCompany — creates account, members,
 *      account_contacts, Drive migration, SD link, tier sync.
 *   6. Return materialization result.
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { canPerform } from "@/lib/permissions"
import { ensureContactFolder } from "@/lib/drive-folder-utils"
import { uploadBinaryToDrive } from "@/lib/google-drive"
import { materializeFormationCompany } from "@/lib/operations/formation-materialize"

export const maxDuration = 120

export async function POST(req: NextRequest) {
  // Auth — admin only.
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!canPerform(user, "materialize_company")) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  }

  try {
    const form = await req.formData()
    const file = form.get("file") as File | null
    const contactId = form.get("contact_id") as string | null
    const formationDate = form.get("formation_date") as string | null
    const filingId = (form.get("filing_id") as string | null) || undefined
    const registeredAgentId = (form.get("registered_agent_id") as string | null) || undefined
    const formationStateRaw = (form.get("formation_state") as string | null)?.trim().toUpperCase() || undefined
    const VALID_STATES = new Set(["NM", "WY", "FL", "DE"])
    const formationState = formationStateRaw && VALID_STATES.has(formationStateRaw)
      ? (formationStateRaw as "NM" | "WY" | "FL" | "DE")
      : undefined
    // Optional admin entity-type override (highest-priority source in the
    // materializer's resolution chain; normally omitted — the signed contract
    // resolves it automatically).
    const entityTypeRaw = (form.get("entity_type") as string | null)?.trim().toUpperCase() || undefined
    const entityType = entityTypeRaw === "SMLLC" || entityTypeRaw === "MMLLC"
      ? (entityTypeRaw as "SMLLC" | "MMLLC")
      : undefined

    if (!file || !contactId) {
      return NextResponse.json({ error: "file and contact_id are required" }, { status: 400 })
    }
    if (formationStateRaw && !formationState) {
      return NextResponse.json(
        { error: `Invalid formation_state "${formationStateRaw}". Expected NM, WY, FL, or DE.` },
        { status: 400 },
      )
    }
    if (entityTypeRaw && !entityType) {
      return NextResponse.json(
        { error: `Invalid entity_type "${entityTypeRaw}". Expected SMLLC or MMLLC.` },
        { status: 400 },
      )
    }

    // 1. Resolve contact + chosen name (so we can build a clean filename).
    const { data: contact } = await supabaseAdmin
      .from("contacts")
      .select("id, first_name, last_name, full_name, drive_folder_id")
      .eq("id", contactId)
      .single()
    if (!contact) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 })
    }

    const contactName =
      [contact.first_name, contact.last_name].filter(Boolean).join(" ") ||
      contact.full_name ||
      "Client"

    const { data: wp } = await supabaseAdmin
      .from("wizard_progress")
      .select("data")
      .eq("contact_id", contactId)
      .eq("wizard_type", "formation")
      .eq("status", "submitted")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    const wizardData = (wp?.data || {}) as Record<string, unknown>
    const chosenName = String(wizardData.chosen_name_final || wizardData.chosen_name || "").trim()
    if (!chosenName) {
      return NextResponse.json(
        { error: "No chosen LLC name on this contact. Click 'Confirm Selected Name' on the LLC Name Selection card first." },
        { status: 400 },
      )
    }

    // 2-4. Drive: ensure contact folder, upload Articles, insert documents row.
    // In sandbox (SANDBOX_MODE=1), Drive writes are mocked and listFiles on the
    // mock id 404s — same pattern formation-setup handles by catching and
    // continuing. In production, Drive failure here is a real error; surface it.
    const isSandbox = process.env.SANDBOX_MODE === '1'
    const safeChosen = chosenName.replace(/[^A-Za-z0-9_ -]/g, "").trim()
    const fileName = `Articles of Organization - ${safeChosen || "LLC"}.pdf`
    let driveFileId: string | null = null
    try {
      const folderResult = await ensureContactFolder(contactId, contactName)
      const companySubfolderId = folderResult.subfolders["1. Company"]
      if (!companySubfolderId) {
        throw new Error("Contact Drive folder is missing the '1. Company' subfolder.")
      }
      const buffer = Buffer.from(await file.arrayBuffer())
      const mimeType = file.type || "application/pdf"
      const driveFile = await uploadBinaryToDrive(fileName, buffer, mimeType, companySubfolderId) as { id: string }
      driveFileId = driveFile.id

      await supabaseAdmin.from("documents").insert({
        file_name: fileName,
        drive_file_id: driveFile.id,
        drive_link: `https://drive.google.com/file/d/${driveFile.id}/view`,
        document_type_name: "Articles of Organization",
        category: 1,
        category_name: "Company",
        status: "classified",
        contact_id: contactId,
        account_id: null,
        portal_visible: true,
      })
    } catch (driveErr) {
      const msg = driveErr instanceof Error ? driveErr.message : String(driveErr)
      if (!isSandbox) {
        return NextResponse.json({ error: `Drive upload failed: ${msg}` }, { status: 500 })
      }
      console.warn("[upload-articles] Sandbox Drive failure (expected — Drive writes blocked in sandbox):", msg)
    }

    // 5. Materialize the company.
    const result = await materializeFormationCompany({
      contact_id: contactId,
      formation_date: formationDate || undefined,
      filing_id: filingId,
      registered_agent_id: registeredAgentId,
      formation_state: formationState,
      entity_type: entityType,
      actor: `crm-admin:${user?.email ?? "unknown"}`,
    })

    if (!result.success) {
      return NextResponse.json(
        {
          error: result.error || `Materialization failed (${result.outcome})`,
          outcome: result.outcome,
          steps: result.steps,
          drive_file_id: driveFileId,
        },
        { status: 500 },
      )
    }

    // Backfill documents row with the new account_id once we have it.
    if (result.account_id && driveFileId) {
      await supabaseAdmin
        .from("documents")
        .update({ account_id: result.account_id, updated_at: new Date().toISOString() })
        .eq("drive_file_id", driveFileId)
    }

    return NextResponse.json({
      success: true,
      outcome: result.outcome,
      account_id: result.account_id,
      steps: result.steps,
      drive_file_id: driveFileId,
      drive_link: driveFileId ? `https://drive.google.com/file/d/${driveFileId}/view` : null,
      sandbox_drive_skipped: isSandbox && !driveFileId ? true : undefined,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[upload-articles] Error:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
