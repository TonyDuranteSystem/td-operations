/**
 * Relocate flow-uploaded documents that are still parked in Supabase Storage
 * into the company's Google Drive "1. Company" subfolder, once the company
 * exists (i.e. at materialization).
 *
 * WHY THIS EXISTS (Slack bug report 2026-07-08 — Art of Profit Academy LLC;
 * also Numero Uno Social LLC, Automatiko LLC):
 * The Company Formation Workspace uploads the Articles of Organization at the
 * CONTACT-SCOPED "Filed with State" stage — BEFORE the company (and therefore
 * its Drive folder) is materialized. With no Drive folder to target,
 * app/api/flows/[id]/upload-document falls back to Supabase Storage: the binary
 * lands in bucket `onboarding-uploads` at path `flow-uploads/<sd>/<file>` and
 * the documents row is stamped `drive_file_id = 'storage:flow-uploads/...'`.
 * A moment later the upload auto-advances into "Articles Received", which
 * materializes the company + its Drive folder — but formation-materialize's
 * step 10a only backfills `documents.account_id`; it never copies the binary
 * into Drive. Net effect: the Articles never reach Google Drive AND the
 * signed-SS-4 IRS merge (app/api/ss4-signed, which scans the Drive
 * "1. Company" folder for an Articles PDF) can't find them → the faxed IRS
 * package contains the SS-4 only.
 *
 * This helper closes the gap at the choke-point where the Drive folder first
 * exists (materialization): it downloads each still-in-Storage flow document
 * and uploads it into the "1. Company" subfolder, then repoints the documents
 * row at the real Drive file. Because the merge reads from Drive, fixing the
 * Drive placement also fixes the IRS package for every future formation.
 *
 * Guarantees:
 * - Idempotent: a relocated row's pointer no longer matches `storage:%`, so a
 *   re-run selects nothing. A same-name file already in the folder (a prior run
 *   or a manual upload) is re-linked, not re-uploaded (LT Program
 *   duplicate-upload incident class).
 * - Non-fatal: a per-document failure is collected in `errors` and never throws
 *   out of the loop, so it can never break materialization.
 *
 * The core (`relocateFlowStorageDocsToDrive`) takes all I/O via injected deps so
 * it is unit-testable without a DB or Drive. `relocateFormationFlowDocs` is the
 * production wrapper that binds the deps to supabaseAdmin + google-drive.
 */

const STORAGE_BUCKET = "onboarding-uploads"
const STORAGE_PREFIX = "storage:"
/** Formation stage whose upload is the Articles of Organization. */
const ARTICLES_FLOW_STAGE = "Filed with State"

export interface StorageFlowDoc {
  id: string
  file_name: string
  /** Expected shape: 'storage:flow-uploads/<sd>/<file>'. */
  drive_file_id: string
  mime_type: string | null
}

export interface RelocateFlowDocsDeps {
  /** Flow-stage docs for these SDs whose binary is still in Supabase Storage. */
  listStorageDocs: (serviceDeliveryIds: string[]) => Promise<StorageFlowDoc[]>
  /** Download a binary from a Supabase Storage bucket by path; null if missing. */
  downloadStorage: (bucket: string, path: string) => Promise<Buffer | null>
  /** Does a file with this exact name already live in the Drive folder? */
  fileExistsInFolder: (folderId: string, fileName: string) => Promise<{ exists: boolean; id?: string }>
  /** Upload a binary into a Drive folder; returns the new file id. */
  uploadToDrive: (fileName: string, data: Buffer, mimeType: string, folderId: string) => Promise<{ id: string }>
  /** Repoint the documents row at the real Drive file. */
  updatePointer: (docId: string, driveFileId: string, driveLink: string) => Promise<void>
}

export interface RelocateResult {
  relocated: number
  skipped: number
  errors: string[]
}

function driveViewLink(fileId: string): string {
  return `https://drive.google.com/file/d/${fileId}/view`
}

/**
 * Pure core: move each storage-parked flow doc into `companySubfolderId`.
 * All I/O is injected. Never throws — per-doc failures land in `errors`.
 */
export async function relocateFlowStorageDocsToDrive(
  params: { companySubfolderId: string | null; serviceDeliveryIds: string[] },
  deps: RelocateFlowDocsDeps,
): Promise<RelocateResult> {
  const result: RelocateResult = { relocated: 0, skipped: 0, errors: [] }
  if (!params.companySubfolderId || params.serviceDeliveryIds.length === 0) return result

  const docs = await deps.listStorageDocs(params.serviceDeliveryIds)
  for (const doc of docs) {
    try {
      if (!doc.drive_file_id.startsWith(STORAGE_PREFIX)) {
        // Already in Drive (or a non-storage pointer) — nothing to relocate.
        result.skipped++
        continue
      }
      const storagePath = doc.drive_file_id.slice(STORAGE_PREFIX.length)

      // Dedup: a same-name file already in the folder (prior run OR a manual
      // upload by staff) → relink the row to it instead of creating a copy.
      const existing = await deps.fileExistsInFolder(params.companySubfolderId, doc.file_name)
      if (existing.exists && existing.id) {
        await deps.updatePointer(doc.id, existing.id, driveViewLink(existing.id))
        result.skipped++
        continue
      }

      const buffer = await deps.downloadStorage(STORAGE_BUCKET, storagePath)
      if (!buffer) {
        result.errors.push(`${doc.file_name}: storage download returned no data (${storagePath})`)
        continue
      }

      const uploaded = await deps.uploadToDrive(
        doc.file_name,
        buffer,
        doc.mime_type || "application/pdf",
        params.companySubfolderId,
      )
      await deps.updatePointer(doc.id, uploaded.id, driveViewLink(uploaded.id))
      result.relocated++
    } catch (e) {
      result.errors.push(`${doc.file_name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return result
}

/**
 * Production wrapper: relocate the formation "Filed with State" flow documents
 * (the Articles of Organization) for `serviceDeliveryIds` into the account's
 * "1. Company" Drive subfolder. Binds injected deps to supabaseAdmin +
 * google-drive. Best-effort — the caller (materialization) treats the result as
 * a status step, never a hard failure.
 */
export async function relocateFormationFlowDocs(params: {
  companySubfolderId: string | null
  serviceDeliveryIds: string[]
}): Promise<RelocateResult> {
  const { supabaseAdmin } = await import("@/lib/supabase-admin")

  const deps: RelocateFlowDocsDeps = {
    listStorageDocs: async (sdIds) => {
      // service_delivery_id / flow_stage are not in the generated types yet.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (supabaseAdmin as any)
        .from("documents")
        .select("id, file_name, drive_file_id, mime_type")
        .in("service_delivery_id", sdIds)
        .eq("flow_stage", ARTICLES_FLOW_STAGE)
        .like("drive_file_id", `${STORAGE_PREFIX}%`)
      return (data ?? []) as StorageFlowDoc[]
    },
    downloadStorage: async (bucket, path) => {
      const { data } = await supabaseAdmin.storage.from(bucket).download(path)
      return data ? Buffer.from(await data.arrayBuffer()) : null
    },
    fileExistsInFolder: async (folderId, fileName) => {
      const { fileExistsInFolder } = await import("@/lib/google-drive")
      return fileExistsInFolder(folderId, fileName)
    },
    uploadToDrive: async (fileName, data, mimeType, folderId) => {
      const { uploadBinaryToDrive } = await import("@/lib/google-drive")
      return (await uploadBinaryToDrive(fileName, data, mimeType, folderId)) as { id: string }
    },
    updatePointer: async (docId, driveFileId, driveLink) => {
      await supabaseAdmin
        .from("documents")
        .update({ drive_file_id: driveFileId, drive_link: driveLink, updated_at: new Date().toISOString() })
        .eq("id", docId)
    },
  }

  return relocateFlowStorageDocsToDrive(
    { companySubfolderId: params.companySubfolderId, serviceDeliveryIds: params.serviceDeliveryIds },
    deps,
  )
}
