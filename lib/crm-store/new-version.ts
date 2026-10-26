/**
 * Save a new version of an EXISTING storage file from the web page (dev job bd21e833, master plan Part 54, step 1).
 * The page stages the chosen file (same staged upload as every other upload); this reads it, runs the plain checks, and hands the
 * bytes to the ONE safe save (appendVersionBytes → database function store_append_version). Also "make this older copy the current
 * copy" (restore = a normal new version made from an old one — nothing is ever deleted).
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { appendVersionBytes, INLINE_REGISTER_MAX_BYTES, sha256Hex, STORE_BUCKET } from "./writer"
import { checkReplacement, conflictText, lockText, statusMessage, type NewVersionReply } from "./new-version-rules"
import { mintConfirmToken, verifyConfirmToken } from "./confirm-token"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
const db = () => supabaseAdmin as any
const STAGING_BUCKET = "onboarding-uploads"
const STAGING_PREFIX = "crm-uploads/store-staging/"

export interface NewVersionRequest {
  fileId: string
  storagePath: string
  fileName: string
  mimeType: string | null
  baseVersionNo: number
  /** the person saw the "different type / much smaller" question and said yes */
  acceptWarnings?: boolean
  /** keep as a hidden "not applied" version after a conflict */
  keepUnmerged?: boolean
  /** the file is shown to the client now: "keep" it shown with the new version (default) or "hide" it BEFORE the new version is saved */
  clientChoice?: "keep" | "hide"
  /** amended return: the typed reason + the token the server gave this person for these exact bytes */
  reason?: string | null
  confirmToken?: string | null
  actor: { userId: string | null; ip?: string | null; userAgent?: string | null }
}

async function currentInfo(fileId: string): Promise<{ name: string; mime: string | null; size: number | null } | null> {
  const { data, error } = await db().from("store_files").select("name, store_file_versions!store_files_current_version_fk(size_bytes, mime_type)").eq("id", fileId).maybeSingle()
  if (error || !data) return null
  const v = data.store_file_versions as { size_bytes: number | null; mime_type: string | null } | null
  return { name: data.name as string, mime: v?.mime_type ?? null, size: v?.size_bytes ?? null }
}

/** a person's login id → the name shown in the versions list (the part of the email before the @), never the raw id */
async function personName(id: string | null | undefined): Promise<string | null> {
  if (!id) return null
  try {
    const { data } = await supabaseAdmin.auth.admin.getUserById(id)
    const email = data?.user?.email
    return email ? email.split("@")[0] : null
  } catch { return null }
}
/** a plain date and time (New York, where the firm works), never a machine timestamp */
function plainWhen(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
}

const removeStaged = (path: string) => db().storage.from(STAGING_BUCKET).remove([path]).catch(() => {})

/** The sentence added to a reply when the file could not be shown to the client again after a refused save. */
export function reshowFailedNote(e: unknown): string {
  return `The file stays hidden from the client: ${e instanceof Error && e.message ? e.message : "it could not be shown again"} — show it again from the file's menu if it should be shared.`
}

export async function saveNewVersionFromStaged(r: NewVersionRequest): Promise<NewVersionReply & { warnings?: string[] }> {
  if (!r.storagePath.startsWith(STAGING_PREFIX) || r.storagePath.includes("..")) return { status: "refused", message: "That upload is not valid — please choose the file again." }
  const info = await currentInfo(r.fileId)
  if (!info) { await removeStaged(r.storagePath); return { status: "not_found", message: statusMessage("not_found", "") } }
  // the size is read from the storage listing BEFORE anything is downloaded: a huge object is refused without being read
  const slash = r.storagePath.lastIndexOf("/")
  const { data: listed } = await db().storage.from(STAGING_BUCKET).list(r.storagePath.slice(0, slash), { search: r.storagePath.slice(slash + 1), limit: 5 })
  const stagedSize = ((listed ?? []) as Array<{ name: string; metadata?: { size?: number } | null }>).find((o) => o.name === r.storagePath.slice(slash + 1))?.metadata?.size
  if (typeof stagedSize === "number" && stagedSize > INLINE_REGISTER_MAX_BYTES) {
    await removeStaged(r.storagePath)
    return { status: "refused", message: `That file is ${(stagedSize / 1048576).toFixed(0)} MB — a new version can be up to ${INLINE_REGISTER_MAX_BYTES / 1048576} MB for now.` }
  }
  const { data: blob, error: dlErr } = await db().storage.from(STAGING_BUCKET).download(r.storagePath)
  if (dlErr || !blob) { console.error("[crm-store] staged file unreadable:", dlErr?.message); return { status: "refused", message: "The chosen file could not be read — please choose it again." } }
  const blobType: string = blob.type
  // one copy: the Buffer takes over the downloaded memory (no second copy is made)
  const bytes = Buffer.from(await blob.arrayBuffer())
  if (bytes.length > INLINE_REGISTER_MAX_BYTES) { await removeStaged(r.storagePath); return { status: "refused", message: `That file is ${(bytes.length / 1048576).toFixed(0)} MB — a new version can be up to ${INLINE_REGISTER_MAX_BYTES / 1048576} MB for now.` } }
  const mime = r.mimeType || blobType || info.mime || "application/octet-stream"

  const chk = checkReplacement({ name: info.name, mimeType: info.mime, size: info.size }, { name: r.fileName, mimeType: mime, size: bytes.length })
  if (chk.block) { await removeStaged(r.storagePath); return { status: "refused", message: chk.block } }
  if (chk.warnings.length > 0 && !r.acceptWarnings) {
    // nothing is saved; the page asks, then stages the file again and sends it with acceptWarnings
    await removeStaged(r.storagePath)
    return { status: "refused", message: "Please confirm.", warnings: chk.warnings }
  }

  const sha = sha256Hex(bytes)
  const confirmed = !!r.actor.userId && verifyConfirmToken(r.confirmToken ?? null, { fileId: r.fileId, baseVersionNo: r.baseVersionNo, userId: r.actor.userId, sha256: sha })
  // the reason is a SERVER rule, not just a pop-up rule: a confirmed change to an amended return always carries a typed reason
  if (confirmed && (r.reason ?? "").trim().length < 3) { await removeStaged(r.storagePath); return { status: "refused", message: "Please type why the amended return is being changed." } }

  // "hide it from the client": done BEFORE the new copy is saved, so the client never sees the new copy, not even for a moment.
  // If the save then does not go through, the file is shown again (only if it WAS shown).
  let hiddenByUs = false
  if (r.clientChoice === "hide" && !r.keepUnmerged) {
    const { storePointer } = await import("./document-pointer")
    const { data: rows } = await db().from("documents").select("portal_visible").eq("drive_file_id", storePointer(r.fileId))
    const wasShown = ((rows ?? []) as { portal_visible: boolean | null }[]).some((x) => x.portal_visible === true)
    if (wasShown) {
      try {
        const { setClientVisibility } = await import("./browse")
        await setClientVisibility(r.fileId, false, r.actor.userId, { silent: true })
        hiddenByUs = true
      } catch (e) { await removeStaged(r.storagePath); return { status: "refused", message: e instanceof Error ? e.message : "The file could not be hidden from the client, so nothing was saved." } }
    }
  }
  // the file is shown again when the save did not go through; if THAT fails too, staff are told plainly (never only a log line)
  const reshowIfNotSaved = async (saved: boolean): Promise<string | null> => {
    if (!hiddenByUs || saved) return null
    try { const { setClientVisibility } = await import("./browse"); await setClientVisibility(r.fileId, true, r.actor.userId, { silent: true }); return null } catch (e) {
      console.error("[crm-store] could not show the file to the client again after a refused save:", e instanceof Error ? e.message : e)
      return reshowFailedNote(e)
    }
  }
  let res
  try {
    res = await appendVersionBytes({
      fileId: r.fileId, bytes, mimeType: mime, expectedVersionNo: r.baseVersionNo, actor: r.actor.userId, source: "web",
      confirmed, unmerged: r.keepUnmerged === true, reason: confirmed ? (r.reason ?? null) : null,
      ip: r.actor.ip ?? null, userAgent: r.actor.userAgent ?? null,
    })
  } catch (e) {
    console.error("[crm-store] new version failed:", e instanceof Error ? e.message : e)
    await removeStaged(r.storagePath)
    const note = await reshowIfNotSaved(false)
    return { status: "refused", message: `The new version could not be saved — please try again.${note ? ` ${note}` : ""}` }
  }
  const reshowNote = await reshowIfNotSaved(res.status === "versioned")
  const reply = async (): Promise<NewVersionReply & { warnings?: string[] }> => {
  const name = res.name ?? info.name
  if (res.status === "needs_confirmation") {
    // the page confirms, then stages the same file again (the token is tied to the file's content, so it still fits)
    await removeStaged(r.storagePath)
    const token = r.actor.userId ? mintConfirmToken({ fileId: r.fileId, baseVersionNo: r.baseVersionNo, userId: r.actor.userId, sha256: sha }) : null
    return { status: "needs_confirmation", kind: "amended", token, message: `"${name}" is an amended return. Changing it needs your confirmation and a short reason.` }
  }
  await removeStaged(r.storagePath)
  if (res.status === "versioned") return { status: "versioned", versionNo: res.versionNo ?? 0, message: `Saved as version ${res.versionNo}. The previous copy is kept under "older copies".` }
  if (res.status === "unmerged") return { status: "unmerged", versionNo: res.versionNo ?? 0, message: `Kept as version ${res.versionNo} (not applied). The current copy was not changed.` }
  if (res.status === "conflict") return { status: "conflict", currentVersionNo: res.currentVersionNo ?? null, message: conflictText({ name, currentVersionNo: res.currentVersionNo, by: await personName(res.currentBy), at: plainWhen(res.currentAt) }) }
  if (res.status === "locked" || res.status === "frozen") return { status: res.status, kind: res.kind ?? (res.status === "frozen" ? "filed" : null), message: lockText(res.status === "frozen" ? "filed" : res.kind, name) }
  if (res.status === "unchanged") return { status: "unchanged", alreadyApplied: res.alreadyApplied, message: statusMessage("unchanged", name) }
  return { status: res.status === "trashed" ? "trashed" : "not_found", message: statusMessage(res.status, name) }
  }
  const rep = await reply()
  return reshowNote ? { ...rep, message: `${rep.message} ${reshowNote}` } as typeof rep : rep
}

/** "Make this the current copy": the old version's bytes saved again as a NEW version (nothing is deleted or rewritten). */
export async function restoreVersion(p: { fileId: string; versionNo: number; baseVersionNo: number; actor: string | null; ip?: string | null; userAgent?: string | null }): Promise<NewVersionReply> {
  const { data: v, error } = await db().from("store_file_versions").select("storage_bucket, storage_path, mime_type, size_bytes").eq("file_id", p.fileId).eq("version_no", p.versionNo).maybeSingle()
  if (error || !v) return { status: "not_found", message: "That older copy no longer exists." }
  if ((v.size_bytes as number | null) !== null && (v.size_bytes as number) > INLINE_REGISTER_MAX_BYTES) return { status: "refused", message: "That copy is too large to restore from here for now." }
  const { data: blob, error: dlErr } = await db().storage.from(v.storage_bucket ?? STORE_BUCKET).download(v.storage_path)
  if (dlErr || !blob) { console.error("[crm-store] older copy unreadable:", dlErr?.message); return { status: "refused", message: "The older copy could not be read — please try again." } }
  const info = await currentInfo(p.fileId)
  let res
  try {
    res = await appendVersionBytes({
      fileId: p.fileId, bytes: Buffer.from(await blob.arrayBuffer()), mimeType: v.mime_type ?? null, expectedVersionNo: p.baseVersionNo,
      actor: p.actor, source: "restore", note: `restored from version ${p.versionNo}`, ip: p.ip ?? null, userAgent: p.userAgent ?? null,
    })
  } catch (e) {
    console.error("[crm-store] restore failed:", e instanceof Error ? e.message : e)
    return { status: "refused", message: "The older copy could not be restored — please try again." }
  }
  const name = res.name ?? info?.name ?? "this file"
  if (res.status === "versioned") return { status: "versioned", versionNo: res.versionNo ?? 0, message: `Version ${p.versionNo} is now the current copy (saved as version ${res.versionNo}).` }
  if (res.status === "conflict") return { status: "conflict", currentVersionNo: res.currentVersionNo ?? null, message: conflictText({ name, currentVersionNo: res.currentVersionNo, by: await personName(res.currentBy), at: plainWhen(res.currentAt) }) }
  if (res.status === "locked" || res.status === "frozen") return { status: res.status, kind: res.kind ?? null, message: lockText(res.status === "frozen" ? "filed" : res.kind, name) }
  if (res.status === "needs_confirmation") return { status: "locked", kind: "amended", message: `"${name}" is an amended return — change it by uploading an edited version, which asks for your confirmation.` }
  if (res.status === "unchanged") return { status: "unchanged", message: `That is already the current copy of "${name}".` }
  return { status: res.status === "trashed" ? "trashed" : "not_found", message: statusMessage(res.status, name) }
}
