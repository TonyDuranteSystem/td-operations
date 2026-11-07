/**
 * The saved copy of an APPROVED tax questionnaire — what the workspace shows and does about it (dev job 7df278cd, Shipment 2).
 *
 *   loadTaxSaveView  → is it saved / saving / failed (and why), where the file is, who approved it, and whether earlier copies wait
 *                      for a decision. Reads only.
 *   saveTaxNow       → save it now, in this request. The durable job is queued first as the fallback (if this request is cut short
 *                      the job finishes the work); the job's own rules make a second run harmless (marker, pinned stamp).
 *   chooseEarlierCopies → "hidden" = leave the earlier copies where they are (History); "visible" = also file each as its own file
 *                      next to the approved one. Nothing is ever deleted.
 *
 * The pure rules (state, reasons, the earlier-copy card) are in save-state.ts. Approve itself is NOT touched here: it never waits
 * for, or fails because of, a save.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { loadTargetTaxSubmission } from "@/lib/tax/target-submission"
import { TAX_WIZARD_SERVICE_TYPES } from "@/lib/tax/wizard-eligibility"
import { archiveTaxSubmission } from "@/lib/tax/archive-submission"
import { enqueueTaxArchiveJob } from "@/lib/tax/archive-enqueue"
import { mergeArchiveMeta } from "@/lib/archive/meta-merge"
import {
  approvedBy,
  decideSaveState,
  earlierCopiesToDecide,
  earlierCopyName,
  readSaveMeta,
  type EarlierCopyChoice,
  type FileVersionLite,
  type LiveJob,
  type SaveMeta,
  type SaveState,
} from "@/lib/tax/save-state"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the store tables are read untyped, like the rest of lib/crm-store
const db = () => supabaseAdmin as any

/** A job that says "running" for longer than this was cut off (the function died); it is not running any more. */
const STALE_RUNNING_MINUTES = 10

export interface TaxSaveFile {
  id: string
  name: string
  /** the company, then the folders down to the file: ["Acme LLC", "3. Tax", "2025"] */
  path: string[]
  version: number
  savedAt: string
  /** the CRM Storage screen, opened on the file's folder */
  storageHref: string
}

export interface TaxSaveView {
  state: SaveState
  file: TaxSaveFile | null
  approved: { at: string; by: string } | null
  /** earlier copies that still wait for staff's choice (empty = no card) */
  earlierToDecide: Array<{ versionNo: number; createdAt: string }>
  /** the choice staff made last time, if any */
  earlierChoice: SaveMeta["earlierCopy"]
}

export type TaxSaveContext =
  | {
      ok: true
      accountId: string
      companyName: string | null
      sub: { id: string; taxYear: number | null; reviewStatus: string | null; reviewHistory: unknown; archivedAt: string | null; meta: SaveMeta }
    }
  | { ok: false; status: number; error: string }

/** The tax submission a flow's panel is about (the same one the review screen shows), with its save bookkeeping. */
export async function loadTaxSaveContext(serviceDeliveryId: string): Promise<TaxSaveContext> {
  const { data: sd, error: sdErr } = await supabaseAdmin.from("service_deliveries").select("id, service_type, account_id").eq("id", serviceDeliveryId).maybeSingle()
  if (sdErr) return { ok: false, status: 500, error: `Could not load the job: ${sdErr.message}` }
  if (!sd) return { ok: false, status: 404, error: "Flow (service delivery) not found" }
  if (!TAX_WIZARD_SERVICE_TYPES.includes(sd.service_type)) return { ok: false, status: 404, error: "This job has no tax questionnaire." }
  const loaded = await loadTargetTaxSubmission(sd.account_id)
  if (loaded.ok === false) {
    if (loaded.reason === "error") return { ok: false, status: 500, error: `Could not load the submission: ${loaded.detail}` }
    return { ok: false, status: 404, error: "This job has no submitted questionnaire." }
  }
  const [{ data: row, error: rowErr }, { data: acc }] = await Promise.all([
    supabaseAdmin.from("tax_return_submissions").select("drive_archived_at, drive_archive_meta").eq("id", loaded.sub.id).maybeSingle(),
    supabaseAdmin.from("accounts").select("company_name").eq("id", loaded.account_id).maybeSingle(),
  ])
  if (rowErr) return { ok: false, status: 500, error: `Could not read the save record: ${rowErr.message}` }
  return {
    ok: true,
    accountId: loaded.account_id,
    companyName: (acc as { company_name?: string | null } | null)?.company_name ?? null,
    sub: {
      id: loaded.sub.id,
      taxYear: loaded.sub.tax_year,
      reviewStatus: loaded.sub.review_status,
      reviewHistory: loaded.sub.review_history,
      archivedAt: (row as { drive_archived_at?: string | null } | null)?.drive_archived_at ?? null,
      meta: readSaveMeta((row as { drive_archive_meta?: unknown } | null)?.drive_archive_meta),
    },
  }
}

/** Is a save job for this submission waiting or running? (a "running" one that was cut off long ago does not count) */
async function liveJobOf(accountId: string, submissionId: string, now: Date): Promise<LiveJob> {
  const { data, error } = await supabaseAdmin
    .from("job_queue")
    .select("status, payload, started_at")
    .eq("job_type", "archive_tax_submission")
    .eq("account_id", accountId)
    .in("status", ["pending", "processing"])
  if (error) return "none" // a read problem must not claim a save is running
  let job: LiveJob = "none"
  for (const r of data ?? []) {
    if ((r.payload as { submission_id?: string } | null)?.submission_id !== submissionId) continue
    if (r.status === "processing") {
      const started = r.started_at ? Date.parse(r.started_at) : NaN
      if (Number.isFinite(started) && now.getTime() - started > STALE_RUNNING_MINUTES * 60_000) continue
      return "processing"
    }
    job = "pending"
  }
  return job
}

async function finishedCompany(accountId: string): Promise<boolean> {
  try {
    return await (await import("@/lib/crm-store/no-storage")).accountIsFinished(accountId)
  } catch {
    return false
  }
}

interface FileFacts {
  file: TaxSaveFile
  ownerId: string
  folderId: string
  versions: FileVersionLite[]
}

async function loadFileFacts(pointer: string | null, companyName: string | null): Promise<FileFacts | null> {
  const { parseStorePointer } = await import("@/lib/crm-store/document-pointer")
  const fileId = parseStorePointer(pointer)
  if (!fileId) return null
  const { data: f } = await db().from("store_files").select("id, name, owner_id, folder_id, state, trashed_at").eq("id", fileId).maybeSingle()
  if (!f || f.state === "purged" || f.trashed_at) return null
  // the folders from the file's folder up to the top; the top folder is the company itself, so it is shown as the company name
  const names: string[] = []
  let cursor: string | null = f.folder_id
  for (let hop = 0; cursor && hop < 8; hop++) {
    const { data: folder } = await db().from("store_folders").select("name, parent_id").eq("id", cursor).maybeSingle()
    if (!folder) break
    if (folder.parent_id) names.unshift(folder.name as string)
    cursor = folder.parent_id as string | null
  }
  const { listFileVersions } = await import("@/lib/crm-store/browse")
  const raw = await listFileVersions(fileId)
  const versions: FileVersionLite[] = raw.map((v) => ({ id: v.id, versionNo: v.versionNo, createdAt: v.createdAt, current: v.current }))
  const current = raw.find((v) => v.current) ?? raw[0]
  return {
    ownerId: f.owner_id as string,
    folderId: f.folder_id as string,
    versions,
    file: {
      id: fileId,
      name: f.name as string,
      path: [companyName ?? "Company", ...names],
      version: current?.versionNo ?? 1,
      savedAt: current?.createdAt ?? "",
      storageHref: `/storage?store=new&owner=${f.owner_id}&folder=${f.folder_id}`,
    },
  }
}

export async function buildTaxSaveView(ctx: Extract<TaxSaveContext, { ok: true }>, now = new Date()): Promise<TaxSaveView> {
  const [job, finished] = await Promise.all([liveJobOf(ctx.accountId, ctx.sub.id, now), finishedCompany(ctx.accountId)])
  const state = decideSaveState({ reviewStatus: ctx.sub.reviewStatus, archivedAt: ctx.sub.archivedAt, meta: ctx.sub.meta, job, finished })
  const approved = approvedBy(ctx.sub.reviewHistory)
  if (state.state !== "saved") return { state, file: null, approved, earlierToDecide: [], earlierChoice: ctx.sub.meta.earlierCopy }
  let facts: FileFacts | null = null
  try {
    facts = await loadFileFacts(ctx.sub.meta.summaryPointer, ctx.companyName)
  } catch (e) {
    console.error("[tax-save] saved, but the file could not be read for the panel (non-fatal):", e)
  }
  return {
    state,
    file: facts?.file ?? null,
    approved,
    earlierToDecide: facts ? earlierCopiesToDecide(facts.versions, ctx.sub.meta.earlierCopy).map((v) => ({ versionNo: v.versionNo, createdAt: v.createdAt })) : [],
    earlierChoice: ctx.sub.meta.earlierCopy,
  }
}

export async function loadTaxSaveView(serviceDeliveryId: string): Promise<{ ok: true; view: TaxSaveView } | { ok: false; status: number; error: string }> {
  const ctx = await loadTaxSaveContext(serviceDeliveryId)
  if (ctx.ok === false) return ctx
  return { ok: true, view: await buildTaxSaveView(ctx) }
}

/**
 * Save the approved answers now. Returns the panel's fresh view. A save that fails is NOT an error of this request: the reason is
 * in the view (the save job recorded it), and the approval is never undone.
 */
export async function saveTaxNow(serviceDeliveryId: string): Promise<{ ok: true; view: TaxSaveView } | { ok: false; status: number; error: string }> {
  const ctx = await loadTaxSaveContext(serviceDeliveryId)
  if (ctx.ok === false) return ctx
  if (ctx.sub.reviewStatus !== "confirmed") return { ok: false, status: 409, error: "The questionnaire is not approved yet, so there is nothing to save." }
  if (!ctx.sub.archivedAt) {
    // the durable job first: if this request is cut short, the job finishes the work (and re-checks the marker, so two runs are harmless)
    await enqueueTaxArchiveJob({ submissionId: ctx.sub.id, accountId: ctx.accountId, createdBy: "tax_save_panel" }).catch((e) => console.error("[tax-save] could not queue the fallback save job (non-fatal):", e))
    // a save already RUNNING is left to finish (a second one in parallel would only repeat its work)
    if ((await liveJobOf(ctx.accountId, ctx.sub.id, new Date())) !== "processing") {
      try {
        await archiveTaxSubmission(ctx.sub.id)
      } catch (e) {
        // the job recorded the reason in the save record; the view below shows it
        console.error("[tax-save] the save did not complete:", e instanceof Error ? e.message : e)
      }
    }
  }
  const fresh = await loadTaxSaveContext(serviceDeliveryId)
  if (fresh.ok === false) return fresh
  return { ok: true, view: await buildTaxSaveView(fresh) }
}

/** Staff's answer to "what should we do with the earlier copies?" */
export async function chooseEarlierCopies(
  serviceDeliveryId: string,
  choice: EarlierCopyChoice,
  by: string,
): Promise<{ ok: true; view: TaxSaveView } | { ok: false; status: number; error: string }> {
  const ctx = await loadTaxSaveContext(serviceDeliveryId)
  if (ctx.ok === false) return ctx
  if (!ctx.sub.archivedAt || ctx.sub.meta.filedIn === "nothing") return { ok: false, status: 409, error: "The approved copy is not saved yet, so there is nothing to decide." }
  const facts = await loadFileFacts(ctx.sub.meta.summaryPointer, ctx.companyName)
  if (!facts) return { ok: false, status: 409, error: "The saved file could not be found in Storage." }
  const earlier = earlierCopiesToDecide(facts.versions, ctx.sub.meta.earlierCopy)
  if (earlier.length === 0) return { ok: false, status: 409, error: "There are no earlier copies waiting for a decision." }

  if (choice === "visible") {
    const { readVersionForStaff } = await import("@/lib/crm-store/browse")
    const { savePilotFile } = await import("@/lib/crm-store/formation-pilot")
    try {
      for (const v of earlier) {
        const got = await readVersionForStaff(facts.file.id, v.id)
        await savePilotFile({
          ownerId: facts.ownerId,
          folderKind: "tax",
          folderId: facts.folderId,
          name: earlierCopyName(facts.file.name, v.versionNo),
          bytes: got.bytes,
          mimeType: got.mimeType,
          documentType: "other_document",
          // one file per earlier version, ever: pressing it twice (or a retry) finds the file it already made
          callerKey: `earlier-copy:${facts.file.id}:${v.id}`,
          published: false,
          periodYear: ctx.sub.taxYear,
        })
      }
    } catch (e) {
      return { ok: false, status: 502, error: `Could not file the earlier copies: ${e instanceof Error ? e.message : String(e)}. Nothing was recorded; press the button again.` }
    }
  }
  // `covered` is how many earlier copies exist IN ALL when staff choose (not just the ones this choice was about): the card then
  // comes back only for a copy that appears later.
  const coveredNow = facts.versions.filter((v) => !v.current).length
  await mergeArchiveMeta("tax_return_submissions", ctx.sub.id, { earlier_copy: { choice, covered: coveredNow, at: new Date().toISOString(), by } })
  const fresh = await loadTaxSaveContext(serviceDeliveryId)
  if (fresh.ok === false) return fresh
  return { ok: true, view: await buildTaxSaveView(fresh) }
}
