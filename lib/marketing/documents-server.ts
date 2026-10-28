/**
 * TD Marketing — Documents (server; dev job 9aec66fa). The team's documents live in the firm's Business storage, in a folder called "Marketing", so the CRM's Storage page and this tab show the SAME
 * files. This layer is the only door: every function first proves the folder or file is INSIDE that Marketing folder (never anywhere else in Business, never a client's storage), then uses the
 * storage's own helpers (listing, safe save with version numbers, rename, trash), so locks, names and history behave exactly as on the Storage page. The permission checks are the routes' job.
 */
import { randomUUID } from "node:crypto"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { ensureArea, createFolder } from "@/lib/crm-store/structure"
import { ensureChildFolder } from "@/lib/crm-store/save-form"
import { folderContents, readFileForStaff } from "@/lib/crm-store/browse"
import { cleanFolderName } from "@/lib/crm-store/names"
import { DOCS_STAGING_BUCKET, MARKETING_DOCS_FOLDER, docRefusal, isOwnStagingPath, stagingPathFor } from "@/lib/marketing/documents-rules"

// store_* tables/functions are not in the generated types until they reach production.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

export class DocsError extends Error { constructor(message: string, public status = 400) { super(message) } }

export interface DocsRoot { ownerId: string; rootFolderId: string }
let rootCache: { at: number; v: DocsRoot } | null = null

/** The Business storage and its "Marketing" folder (made on first use). */
export async function docsRoot(): Promise<DocsRoot> {
  if (rootCache && Date.now() - rootCache.at < 5 * 60_000) return rootCache.v
  const ownerId = await ensureArea("business", null)
  const { data: top, error } = await db().from("store_folders").select("id").eq("owner_id", ownerId).is("parent_id", null).is("trashed_at", null).limit(1)
  if (error || !top?.[0]) throw new DocsError("The Business storage could not be opened. Please try again.", 500)
  const rootFolderId = await ensureChildFolder(top[0].id as string, MARKETING_DOCS_FOLDER)
  rootCache = { at: Date.now(), v: { ownerId, rootFolderId } }
  return rootCache.v
}

/** Is this folder the Marketing folder or somewhere below it (live, same storage)? */
export async function folderInside(folderId: string, root: DocsRoot): Promise<boolean> {
  let id: string | null = folderId
  for (let i = 0; i < 30 && id; i++) {
    const { data }: { data: { id: string; parent_id: string | null; owner_id: string; trashed_at: string | null } | null } = await db().from("store_folders").select("id, parent_id, owner_id, trashed_at").eq("id", id).maybeSingle()
    if (!data || data.owner_id !== root.ownerId || data.trashed_at) return false
    if (data.id === root.rootFolderId) return true
    id = data.parent_id
  }
  return false
}

/** The live file, if it sits inside Marketing. */
async function fileInside(fileId: string, root: DocsRoot): Promise<{ id: string; name: string; folder_id: string; current_version_id: string | null }> {
  const { data } = await db().from("store_files").select("id, owner_id, folder_id, name, state, current_version_id").eq("id", fileId).maybeSingle()
  if (!data || data.owner_id !== root.ownerId || data.state !== "live" || !(await folderInside(data.folder_id as string, root))) throw new DocsError("That document was not found.", 404)
  return data
}

export interface DocsListing {
  crumbs: Array<{ id: string; name: string }>
  folders: Array<{ id: string; name: string }>
  files: Array<{ id: string; name: string; size: number | null; mimeType: string | null; updatedAt: string; versions: number }>
}

export async function listDocs(folderId: string | null): Promise<DocsListing> {
  const root = await docsRoot()
  const target = folderId ?? root.rootFolderId
  if (!(await folderInside(target, root))) throw new DocsError("That folder was not found.", 404)
  const r = await folderContents(root.ownerId, target)
  // the path starts at Business; the tab starts at Marketing
  const start = r.path.findIndex(p => p.id === root.rootFolderId)
  const crumbs = (start === -1 ? [] : r.path.slice(start)).map(p => ({ id: p.id, name: p.name }))
  if (crumbs.length === 0) crumbs.push({ id: root.rootFolderId, name: MARKETING_DOCS_FOLDER })
  return {
    crumbs,
    folders: r.folders.filter(f => !f.trashed).map(f => ({ id: f.id, name: f.name })),
    files: r.files.filter(f => f.state === "live").map(f => ({ id: f.id, name: f.name, size: f.size, mimeType: f.mimeType, updatedAt: f.updatedAt, versions: f.versions })),
  }
}

export async function makeFolder(parentId: string, name: string, actorId: string): Promise<{ id: string; name: string }> {
  const root = await docsRoot()
  if (!(await folderInside(parentId, root))) throw new DocsError("That folder was not found.", 404)
  const clean = cleanFolderName(name)
  if (!clean) throw new DocsError("Type a name for the folder.")
  try { return await createFolder(parentId, clean, actorId) } catch (e) { throw new DocsError(e instanceof Error ? e.message : "The folder could not be made.") }
}

/** A single-use signed link to send one file straight to storage (the web server's request-size limit never applies). */
export async function startUpload(folderId: string, fileName: string, size: number): Promise<{ signedUrl: string; path: string }> {
  const root = await docsRoot()
  if (!(await folderInside(folderId, root))) throw new DocsError("That folder was not found.", 404)
  const refusal = docRefusal(fileName, size)
  if (refusal) throw new DocsError(refusal)
  const path = stagingPathFor(root.ownerId, fileName, new Date(), randomUUID())
  const { data, error } = await supabaseAdmin.storage.from(DOCS_STAGING_BUCKET).createSignedUploadUrl(path)
  if (error || !data) throw new DocsError("Could not start the upload. Please try again.", 500)
  return { signedUrl: data.signedUrl, path }
}

export interface SavedDoc { status: "created" | "versioned" | "unchanged"; name: string; message: string }

/** The uploaded file becomes a new document, or — with `replaceFileId` — the next version of an existing one. */
export async function finishUpload(i: { folderId: string; path: string; fileName: string; mimeType: string | null; replaceFileId: string | null; actorId: string }): Promise<SavedDoc> {
  const root = await docsRoot()
  if (!isOwnStagingPath(i.path, root.ownerId)) throw new DocsError("That upload is not valid — please choose the file again.")
  if (i.replaceFileId) {
    const f = await fileInside(i.replaceFileId, root)
    let baseVersionNo = 0
    if (f.current_version_id) {
      const { data: v } = await db().from("store_file_versions").select("version_no").eq("id", f.current_version_id).maybeSingle()
      baseVersionNo = (v?.version_no as number | undefined) ?? 0
    }
    const { saveNewVersionFromStaged } = await import("@/lib/crm-store/new-version")
    const r = await saveNewVersionFromStaged({ fileId: f.id, storagePath: i.path, fileName: i.fileName, mimeType: i.mimeType, baseVersionNo, acceptWarnings: true, actor: { userId: i.actorId } })
    if (r.status === "versioned") return { status: "versioned", name: f.name, message: `"${f.name}" now has a new version (version ${r.versionNo}). The old one is kept.` }
    if (r.status === "unchanged") return { status: "unchanged", name: f.name, message: r.message }
    throw new DocsError(r.message || "The new version could not be saved.")
  }
  if (!(await folderInside(i.folderId, root))) throw new DocsError("That folder was not found.", 404)
  const { staffUploadToStore } = await import("@/lib/crm-store/browse")
  try {
    const r = await staffUploadToStore({ ownerId: root.ownerId, folderId: i.folderId, storagePath: i.path, fileName: i.fileName, mimeType: i.mimeType, documentType: null, actorId: i.actorId, visible: false })
    const status = r.write === "versioned" ? "versioned" : r.write === "unchanged" ? "unchanged" : "created"
    return { status, name: r.name, message: status === "versioned" ? `"${r.name}" was already here, so this is saved as its new version. The old one is kept.` : status === "unchanged" ? `"${r.name}" is already here, exactly the same.` : `"${r.name}" was uploaded.` }
  } catch (e) {
    throw new DocsError(e instanceof Error ? e.message : "The upload could not be saved.")
  }
}

export async function readDoc(fileId: string): Promise<{ bytes: Buffer; mimeType: string | null; name: string }> {
  const root = await docsRoot()
  await fileInside(fileId, root)
  try { return await readFileForStaff(fileId) } catch { throw new DocsError("That document could not be read. Please try again.", 500) }
}

export async function renameDoc(fileId: string, name: string, actorId: string): Promise<{ name: string }> {
  const root = await docsRoot()
  await fileInside(fileId, root)
  const { renameStoreFile } = await import("@/lib/crm-store/file-actions")
  try { return await renameStoreFile(fileId, name, actorId) } catch (e) { throw new DocsError(e instanceof Error ? e.message : "The document could not be renamed.") }
}

/** To the storage's trash (restorable from the Storage page for 90 days), never a hard delete. */
export async function trashDoc(fileId: string, actorId: string): Promise<void> {
  const root = await docsRoot()
  await fileInside(fileId, root)
  const { error } = await db().rpc("store_trash_file", { p_file_id: fileId, p_actor: actorId, p_reason: "Deleted from TD Marketing Documents" })
  if (error) throw new DocsError("The document could not be deleted. Please try again.", 500)
}

export async function trashFolderDoc(folderId: string, actorId: string): Promise<void> {
  const root = await docsRoot()
  if (folderId === root.rootFolderId) throw new DocsError("The Marketing folder itself cannot be deleted.")
  if (!(await folderInside(folderId, root))) throw new DocsError("That folder was not found.", 404)
  const { error } = await db().rpc("store_trash_folder", { p_folder_id: folderId, p_actor: actorId, p_reason: "Deleted from TD Marketing Documents" })
  if (error) throw new DocsError("The folder could not be deleted. Please try again.", 500)
}
