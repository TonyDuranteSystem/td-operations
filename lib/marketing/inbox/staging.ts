/**
 * TD Marketing — files attached to an email being written (dev job 9aec66fa). The browser uploads straight to the private `marketing-chat` bucket with a one-time signed address (a Vercel function
 * cannot take a big body), under <team>/inbox/<person>/<uuid>.<ext>; at send time the server reads them back (only paths inside THAT person's own folder count), builds the email, and deletes them.
 */
import { randomUUID } from "node:crypto"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { BUCKET } from "@/lib/marketing/lead-chat"
import { MAX_ATTACHMENT_BYTES } from "@/lib/marketing/inbox/compose"
import type { OutgoingFile } from "@/lib/marketing/inbox/mail-types"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const storage = () => (supabaseAdmin as unknown as { storage: any }).storage

export const MAX_FILES = 10
const UUID_PATH = /^[0-9a-f-]{36}\.[a-z0-9]{1,8}$/i

export const inboxFolder = (teamId: string, userId: string): string => `${teamId}/inbox/${userId}/`

export function newInboxPath(teamId: string, userId: string, fileName: string, uuid: string = randomUUID()): string {
  const ext = (fileName.split(".").pop() ?? "bin").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "bin"
  return `${inboxFolder(teamId, userId)}${uuid}.${ext}`
}

/** A path counts only when it is exactly one of OUR object names inside THIS person's own inbox folder (the path comes from the browser). */
export function isOwnInboxPath(path: unknown, teamId: string, userId: string): path is string {
  if (typeof path !== "string") return false
  const prefix = inboxFolder(teamId, userId)
  return path.startsWith(prefix) && UUID_PATH.test(path.slice(prefix.length))
}

/** Staged files nobody sent are thrown away after a day (closed browser, lost connection): the names of the stale ones in a listing of the person's folder. */
export const STALE_STAGED_MS = 24 * 3600 * 1000
export function staleStaged(listing: ReadonlyArray<{ name?: string; created_at?: string | null }>, folder: string, now: number): string[] {
  return listing
    .filter(o => typeof o.name === "string" && UUID_PATH.test(o.name) && o.created_at && now - Date.parse(o.created_at) > STALE_STAGED_MS)
    .map(o => `${folder}${o.name}`)
}

/** Best effort and bounded: never lets a failed clean-up stop an upload. */
export async function sweepStaleStaged(teamId: string, userId: string, now = Date.now()): Promise<void> {
  try {
    const folder = inboxFolder(teamId, userId)
    const { data } = await storage().from(BUCKET).list(folder.replace(/\/$/, ""), { limit: 200 })
    const old = staleStaged(Array.isArray(data) ? data : [], folder, now)
    if (old.length) await storage().from(BUCKET).remove(old)
  } catch { /* the clean-up is only housekeeping */ }
}

export async function createInboxUploadUrl(teamId: string, userId: string, fileName: unknown): Promise<{ ok: true; signedUrl: string; token: string; path: string } | { ok: false; error: string; status: number }> {
  if (typeof fileName !== "string" || !fileName.trim()) return { ok: false, error: "file_name required", status: 400 }
  await sweepStaleStaged(teamId, userId)
  const path = newInboxPath(teamId, userId, fileName)
  const { data, error } = await storage().from(BUCKET).createSignedUploadUrl(path)
  if (error || !data) return { ok: false, error: "Could not start the upload. Please try again.", status: 500 }
  return { ok: true, signedUrl: data.signedUrl, token: data.token, path }
}

export interface StagedRef { path: string; name: string; mime_type?: string }

/** The staged files as ready-to-attach bytes, or a plain error. Names come from the browser but only ever become the attachment's own file name. */
export async function loadStaged(teamId: string, userId: string, refs: unknown): Promise<{ ok: true; files: OutgoingFile[]; paths: string[] } | { ok: false; error: string }> {
  if (refs === undefined || refs === null) return { ok: true, files: [], paths: [] }
  if (!Array.isArray(refs) || refs.length > MAX_FILES) return { ok: false, error: `At most ${MAX_FILES} attachments.` }
  const files: OutgoingFile[] = []
  const paths: string[] = []
  let total = 0
  for (const r of refs as Array<Record<string, unknown>>) {
    if (!isOwnInboxPath(r?.path, teamId, userId)) return { ok: false, error: "An attachment is not valid. Attach it again." }
    const { data, error } = await storage().from(BUCKET).download(r.path)
    if (error || !data) return { ok: false, error: "An attachment could not be read. Attach it again." }
    const buf = Buffer.from(await (data as Blob).arrayBuffer())
    total += buf.length
    if (total > MAX_ATTACHMENT_BYTES) return { ok: false, error: "The attachments are too big. Keep them under 18 MB together." }
    files.push({ filename: typeof r.name === "string" && r.name.trim() ? r.name : "attachment", contentType: typeof r.mime_type === "string" ? r.mime_type : "application/octet-stream", content: buf.toString("base64") })
    paths.push(r.path)
  }
  return { ok: true, files, paths }
}

export async function deleteStaged(paths: string[]): Promise<void> {
  if (paths.length === 0) return
  await storage().from(BUCKET).remove(paths).catch(() => {})
}
