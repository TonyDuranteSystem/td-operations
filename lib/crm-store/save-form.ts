/**
 * CRM Store — form summaries + their uploaded files for a SWITCHED company/person (cutover Phase 2, dev job ad09ea91).
 *
 * `saveFormToDrive` (lib/form-to-drive.ts) is the ONE place every form flow files its summary PDF and uploads
 * (formation, onboarding, tax, ITIN, banking, closure — 14 callers, plus the overnight archive jobs). It is keyed by a
 * Drive folder id, so the question "do these files live in the new storage?" is asked of that folder: the company or
 * person who owns it. A switched owner gets the files in its storage (same top folder as the Drive path used), nothing
 * is written to Drive; anyone else carries on with Drive exactly as before.
 *
 * Like the Drive path, form files are saved without a CRM documents row (they are the accountant/ops archive).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import type { WriteResult } from "./writer"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
const db = () => supabaseAdmin as any

export interface SwitchedFolderTarget {
  kind: "account" | "contact"
  id: string
  ownerId: string
}

/**
 * The switched company or person that owns this Drive folder; null = the folder belongs to someone still on Drive (or to
 * nobody we know). A company being MOVED right now throws CompanyMovingError (the caller reports it; archive jobs retry).
 * Strict: a read error throws. Two records claiming one folder throws (never guess whose it is).
 */
export async function switchedTargetForFolder(driveFolderId: string): Promise<SwitchedFolderTarget | null> {
  const { companyDocState, liveOwnerOfAccount, liveOwnerOfContact } = await import("./switched-drive-guard")
  const { CompanyMovingError } = await import("./save-for-account")

  const { data: accts, error: aErr } = await db().from("accounts").select("id").eq("drive_folder_id", driveFolderId).limit(3)
  if (aErr) throw new Error("Could not check where this company's files live — please try again.")
  const { data: contacts, error: cErr } = await db().from("contacts").select("id").eq("drive_folder_id", driveFolderId).limit(3)
  if (cErr) throw new Error("Could not check where this person's files live — please try again.")
  const a = (accts ?? []) as Array<{ id: string }>
  const c = (contacts ?? []) as Array<{ id: string }>
  if (a.length + c.length === 0) return null
  if (a.length + c.length > 1) throw new Error("More than one record claims this Drive folder — nothing was filed (fix the folder link first).")

  if (a.length === 1) {
    const state = await companyDocState(a[0].id)
    if (state === "drive") return null
    if (state === "moving") throw new CompanyMovingError()
    const ownerId = await liveOwnerOfAccount(a[0].id)
    if (!ownerId) throw new Error("This company's files live in the new storage, but its storage could not be found — nothing was filed.")
    return { kind: "account", id: a[0].id, ownerId }
  }
  const ownerId = await liveOwnerOfContact(c[0].id)
  return ownerId ? { kind: "contact", id: c[0].id, ownerId } : null
}

/** The top folder of the storage that matches the Drive sub-folder a form type used. */
export function folderKindForDriveSubfolder(subfolder: string, target: Pick<SwitchedFolderTarget, "kind">): string {
  if (target.kind === "contact") return "personal"
  if (subfolder.startsWith("3.")) return "tax"
  if (subfolder.startsWith("4.")) return "banking"
  if (subfolder.startsWith("5.")) return "correspondence"
  return "company" // "1. Company", and "ITIN" filed under a company
}

/** The tax-year folder inside a Tax folder: found if it exists, created if not. */
export async function ensureYearFolder(taxFolderId: string, year: string): Promise<string> {
  const { data, error } = await db().from("store_folders").select("id").eq("parent_id", taxFolderId).eq("name", year).is("trashed_at", null).limit(1)
  if (error) throw new Error(`store: could not read the tax-year folders — ${error.message}`)
  if (data && data.length > 0) return data[0].id as string
  const { createTaxYear } = await import("./structure")
  try {
    return (await createTaxYear(taxFolderId, year, null)).id
  } catch (e) {
    // a concurrent run created it a moment ago
    const { data: again } = await db().from("store_folders").select("id").eq("parent_id", taxFolderId).eq("name", year).is("trashed_at", null).limit(1)
    if (again && again.length > 0) return again[0].id as string
    throw e
  }
}

export interface FormStoreResult { summaryFileId: string | null; copied: string[]; failed: string[]; skipped: string[]; errors: string[] }

export interface FormStoreSpec {
  target: SwitchedFolderTarget
  /** the Drive sub-folder name the form type used ("3. Tax", "1. Company", "ITIN" …) */
  subfolder: string
  year?: string | number | null
  summary: { name: string; bytes: Buffer | null; documentType: string | null; callerKey: string } | null
  uploadPaths: string[]
  bucketOf: (path: string) => string
  /** unique per submission: the same key on a retry makes new VERSIONS, never copies */
  submissionKey: string
}

export interface FormStoreDeps {
  saveFile: (p: { ownerId: string; folderKind: string; folderId?: string; name: string; bytes: Buffer; mimeType: string | null; documentType: string | null; callerKey: string }) => Promise<WriteResult>
  download: (bucket: string, path: string) => Promise<{ bytes: Buffer; mimeType: string | null } | null>
  yearFolder: (taxFolderId: string, year: string) => Promise<string>
  taxFolder: (ownerId: string) => Promise<string>
}

async function defaultDeps(): Promise<FormStoreDeps> {
  const pilot = await import("./formation-pilot")
  return {
    saveFile: (p) => pilot.savePilotFile({ ...p, published: false }),
    download: async (bucket, path) => {
      const { data, error } = await supabaseAdmin.storage.from(bucket).download(path)
      if (error || !data || data.size === 0) return null
      return { bytes: Buffer.from(await data.arrayBuffer()), mimeType: data.type || null }
    },
    yearFolder: ensureYearFolder,
    taxFolder: (ownerId) => pilot.folderOfKind(ownerId, "tax"),
  }
}

export async function saveFormToStore(spec: FormStoreSpec, deps?: FormStoreDeps): Promise<FormStoreResult> {
  const d = deps ?? (await defaultDeps())
  const out: FormStoreResult = { summaryFileId: null, copied: [], failed: [], skipped: [], errors: [] }
  const folderKind = folderKindForDriveSubfolder(spec.subfolder, spec.target)

  // a tax return's year sub-folder (company storages only — a person's storage has its own layout)
  let folderId: string | undefined
  if (folderKind === "tax" && spec.year != null && spec.target.kind === "account") {
    try {
      folderId = await d.yearFolder(await d.taxFolder(spec.target.ownerId), String(spec.year))
    } catch (e) {
      // never fall back to the top folder: abort so the durable job retries (same rule as the Drive path)
      return { ...out, errors: [`Tax-year folder unresolved (aborted to avoid misfiling): ${e instanceof Error ? e.message : String(e)}`] }
    }
  }

  if (spec.summary?.bytes) {
    try {
      const w = await d.saveFile({ ownerId: spec.target.ownerId, folderKind, folderId, name: spec.summary.name, bytes: spec.summary.bytes, mimeType: "application/pdf", documentType: spec.summary.documentType, callerKey: spec.summary.callerKey })
      out.summaryFileId = w.fileId
    } catch (e) {
      out.errors.push(`Summary PDF error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  for (const path of spec.uploadPaths) {
    const name = path.split("/").pop() || "document.pdf"
    try {
      let got = null
      for (let attempt = 0; attempt < 3 && !got; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, attempt * 1000))
        got = await d.download(spec.bucketOf(path), path)
      }
      if (!got) { out.failed.push(`${name} (download failed after 3 attempts)`); continue }
      const w = await d.saveFile({ ownerId: spec.target.ownerId, folderKind, folderId, name, bytes: got.bytes, mimeType: got.mimeType, documentType: null, callerKey: `form-upload:${spec.submissionKey}:${path}` })
      if (w.status === "unchanged") out.skipped.push(name)
      else out.copied.push(name)
    } catch (e) {
      out.failed.push(`${name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return out
}
