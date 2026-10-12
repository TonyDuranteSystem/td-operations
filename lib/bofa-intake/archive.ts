/**
 * Bank application intake — saves a SUBMITTED application in CRM Storage (Antonio, 2026-10-12: "every
 * application must be saved in storage, under Business, BofA").
 *
 *   Business › BofA › <partner> › <date applicant - company (id)> › 6 documents + "Application answers.pdf"
 *
 * Idempotent: every file has a caller key `bofa:<request id>:<slot>`, so a retry never duplicates. The
 * applicant's browser still uploads to the intake's own private bucket first (a public visitor cannot
 * write to CRM Storage); this copies each file into the store and — only when EVERYTHING saved — removes
 * the temporary copies. If anything fails nothing is removed, the reason is recorded, and staff can press
 * "Save to Storage" again. Never throws.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { ensureArea } from "@/lib/crm-store/structure"
import { saveBytesToStore } from "@/lib/crm-store/writer"
import { BOFA_BUCKET } from "./schema"
import { BOFA_ANSWERS_FILE, folderPath, mimeForName, storedFileName } from "./archive-names"
import { readSubmissionFile, type SubmissionFile } from "./files"
import { buildSummaryPdf } from "./summary-pdf"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- new table not in the generated DB types
const table = () => (supabaseAdmin as any).from("bofa_intake_requests")
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* tables/functions are not in the generated types
const db = () => supabaseAdmin as any

export type ArchiveResult = { ok: true; folderId: string; already: boolean } | { ok: false; error: string }

export async function archiveSubmission(id: string): Promise<ArchiveResult> {
  try {
    const { data: row, error } = await table()
      .select("id, status, partner_name, label, form_data, files, completed_at, store_archived_at, store_folder_id")
      .eq("id", id)
      .maybeSingle()
    if (error || !row) return { ok: false, error: "Application not found." }
    if (row.status !== "completed") return { ok: false, error: "This application has not been submitted." }
    if (row.store_archived_at && row.store_folder_id) return { ok: true, folderId: row.store_folder_id as string, already: true }

    const data = (row.form_data ?? {}) as Record<string, string>
    const files = (Array.isArray(row.files) ? row.files : []) as SubmissionFile[]

    const ownerId = await ensureArea("business", null)
    const { data: root, error: rootErr } = await db()
      .from("store_folders")
      .select("id")
      .eq("owner_id", ownerId)
      .eq("kind", "business_root")
      .is("trashed_at", null)
      .is("parent_id", null)
      .limit(1)
      .maybeSingle()
    if (rootErr || !root) throw new Error("The Business top folder was not found in CRM Storage.")

    const path = folderPath({
      id,
      partner: row.partner_name,
      fullName: data.full_name,
      company: data.company_name,
      submittedAt: row.completed_at,
    })
    const { data: folderId, error: fErr } = await db().rpc("store_ensure_folder_path", {
      p_owner: ownerId,
      p_parent: root.id,
      p_path: path,
      p_actor: null,
    })
    if (fErr || !folderId) throw new Error(`Could not make the BofA folder: ${fErr?.message ?? "no id"}`)

    // the documents
    const saved: SubmissionFile[] = []
    for (const f of files) {
      if (f.store_file_id) { saved.push(f); continue }
      const bytes = await readSubmissionFile(f)
      if (!bytes) throw new Error(`Could not read "${f.name}" to save it.`)
      const name = storedFileName(f.key, f.name)
      const w = await saveBytesToStore({
        ownerId,
        folderId: folderId as string,
        name,
        mimeType: mimeForName(f.name),
        callerKey: `bofa:${id}:${f.key}`,
        contentChanged: true,
        published: false,
        convertHeic: true,
        actor: null,
        documentType: null,
        bytes,
      })
      saved.push({ ...f, store_file_id: w.fileId })
    }

    // the answers, as a PDF next to them
    const pdf = await buildSummaryPdf({ data, partner: row.partner_name ?? null, submittedAt: row.completed_at, requestId: id })
    await saveBytesToStore({
      ownerId,
      folderId: folderId as string,
      name: BOFA_ANSWERS_FILE,
      mimeType: "application/pdf",
      callerKey: `bofa:${id}:answers`,
      contentChanged: false,
      published: false,
      actor: null,
      documentType: null,
      bytes: pdf,
    })

    // everything is in the store: record it, then remove the temporary copies
    const recorded = saved.map((f) => ({ ...f, temp_removed: true }))
    const { error: upErr } = await table()
      .update({
        files: recorded,
        store_owner_id: ownerId,
        store_folder_id: folderId,
        store_archived_at: new Date().toISOString(),
        store_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
    if (upErr) throw new Error(`Saved in Storage but could not record it: ${upErr.message}`)
    const temp = files.filter((f) => !f.store_file_id && f.path).map((f) => f.path)
    if (temp.length) {
      const { error: rmErr } = await supabaseAdmin.storage.from(BOFA_BUCKET).remove(temp)
      if (rmErr) console.error("[bofa-intake] could not remove temporary copies:", rmErr.message)
    }
    return { ok: true, folderId: folderId as string, already: false }
  } catch (e) {
    const message = (e instanceof Error ? e.message : "Could not save to Storage.").slice(0, 500)
    console.error("[bofa-intake] archive failed:", message)
    try {
      await table().update({ store_error: message, updated_at: new Date().toISOString() }).eq("id", id)
    } catch {
      // the error note is best-effort
    }
    return { ok: false, error: message }
  }
}
