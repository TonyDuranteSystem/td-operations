/**
 * Cron: Articles of Organization detector
 * Schedule: hourly via Vercel cron.
 *
 * Backup path for the formation flow. Antonio uploads Articles via the
 * Upload Articles button on the LLC Name Selection card; that's the
 * primary way the company gets created. This cron exists so direct
 * Drive uploads (uploaded into a contact's "1. Company" subfolder
 * outside the CRM) don't slip through.
 *
 * Per Antonio's quote: "When we will have the articles of organization
 * uploaded in the Google Drive, the system can read the drive, see the
 * articles of organization, and start the SS4 application."
 *
 * Detection logic:
 *   1. Find candidate contacts: portal_tier='formation', drive_folder_id
 *      set, no real account linked yet (only a 'Pending Formation'
 *      placeholder counts as no real account).
 *   2. For each: list the contact's "1. Company" Drive subfolder.
 *   3. Run classifyByFilename on each file. If any file matches
 *      "Articles of Organization", trigger materialization.
 *   4. formation_date defaults to today (admin can edit on the account
 *      record after creation).
 *
 * Idempotent: materializeFormationCompany returns 'already_materialized'
 * if a real account is already linked.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logCron } from "@/lib/cron-log"
import { classifyByFilename } from "@/lib/classifier"
import { materializeFormationCompany } from "@/lib/operations/formation-materialize"

interface DriveItem { id: string; name: string; mimeType: string }

export async function GET(req: NextRequest) {
  const startTime = Date.now()
  try {
    const authHeader = req.headers.get("authorization")
    const cronSecret = process.env.CRON_SECRET
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // 1. Candidate contacts.
    const { data: contacts, error } = await supabaseAdmin
      .from("contacts")
      .select("id, full_name, drive_folder_id, portal_tier")
      .eq("portal_tier", "formation")
      .not("drive_folder_id", "is", null)

    if (error) {
      console.error("[articles-detector] Failed to query contacts:", error.message)
      logCron({ endpoint: "/api/cron/articles-detector", status: "error", duration_ms: Date.now() - startTime, error_message: error.message })
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    let scanned = 0
    let detected = 0
    let materialized = 0
    let skippedAlreadyDone = 0
    const findings: Array<{ contact_id: string; outcome: string; account_id?: string; reason?: string }> = []

    const { listFolderAnyDrive } = await import("@/lib/google-drive")

    for (const contact of contacts || []) {
      // Idempotency: skip contacts that already have a real account linked.
      const { data: existingLinks } = await supabaseAdmin
        .from("account_contacts")
        .select("account_id, accounts:account_id(id, status)")
        .eq("contact_id", contact.id)
      const hasRealAccount = (existingLinks || []).some(l => {
        const acc = l.accounts as unknown as { status: string } | null
        return acc && acc.status !== "Pending Formation" && acc.status !== "Cancelled" && acc.status !== "Closed"
      })
      if (hasRealAccount) {
        skippedAlreadyDone++
        continue
      }

      scanned++

      // Find the contact's "1. Company" subfolder.
      let companySubfolderId: string | null = null
      try {
        const items = await listFolderAnyDrive(contact.drive_folder_id!) as { files?: DriveItem[] }
        const company = (items.files ?? []).find(
          f => f.name === "1. Company" && f.mimeType === "application/vnd.google-apps.folder",
        )
        companySubfolderId = company?.id ?? null
      } catch (folderErr) {
        findings.push({ contact_id: contact.id, outcome: "error", reason: `list contact folder failed: ${folderErr instanceof Error ? folderErr.message : String(folderErr)}` })
        continue
      }
      if (!companySubfolderId) {
        findings.push({ contact_id: contact.id, outcome: "no_company_subfolder" })
        continue
      }

      // List files in 1. Company.
      let companyFiles: DriveItem[] = []
      try {
        const items = await listFolderAnyDrive(companySubfolderId) as { files?: DriveItem[] }
        companyFiles = items.files ?? []
      } catch (listErr) {
        findings.push({ contact_id: contact.id, outcome: "error", reason: `list company subfolder failed: ${listErr instanceof Error ? listErr.message : String(listErr)}` })
        continue
      }

      // Classify each file by filename — fast path. Articles found?
      const articlesFile = companyFiles.find(f => {
        if (f.mimeType === "application/vnd.google-apps.folder") return false
        const cls = classifyByFilename(f.name)
        return cls?.type === "Articles of Organization"
      })

      if (!articlesFile) {
        findings.push({ contact_id: contact.id, outcome: "no_articles_yet" })
        continue
      }

      detected++

      // Trigger materialization. formation_date defaults to today.
      const result = await materializeFormationCompany({
        contact_id: contact.id,
        actor: "system:articles-detector-cron",
      })

      findings.push({
        contact_id: contact.id,
        outcome: result.outcome,
        account_id: result.account_id,
        reason: result.success ? undefined : result.error,
      })

      if (result.success && result.outcome === "materialized") materialized++
    }

    console.warn(`[articles-detector] Done. Scanned ${scanned}, detected ${detected}, materialized ${materialized}, skipped ${skippedAlreadyDone}.`)

    logCron({
      endpoint: "/api/cron/articles-detector",
      status: "success",
      duration_ms: Date.now() - startTime,
      details: {
        scanned,
        detected,
        materialized,
        skipped_already_done: skippedAlreadyDone,
        findings: findings.slice(0, 20),
      },
    })

    return NextResponse.json({ ok: true, scanned, detected, materialized, skipped_already_done: skippedAlreadyDone })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[articles-detector] Error:", msg)
    logCron({ endpoint: "/api/cron/articles-detector", status: "error", duration_ms: Date.now() - startTime, error_message: msg })
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
