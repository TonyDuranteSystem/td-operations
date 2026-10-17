/**
 * My files DROP — the one server function behind the MCP tool `my_files_save` (dev job 1ed4fb18, Antonio 2026-10-17).
 *
 * A Claude session may SAVE one file into the owner's private "My files" › "From Claude" folder — and do nothing else there:
 * no read, no list, no overwrite, no delete, no move. This is deliberately NOT a route and NOT a browse helper: it loosens
 * nothing in the private-area guards (`denyUnlessAreaAccess`, `mayOpenPrivateArea` are untouched). Nothing here accepts an
 * owner id or a folder id from the caller; the owner is resolved from PRIMARY_OWNER_EMAIL, the drop folder is a folder that
 * THIS module made and re-verifies on every call.
 *
 * Write-once: every save is written with contentChanged=false, so `store_write` returns "unchanged" for a key that already
 * exists and can never add a version; the stored sha is compared afterwards and a difference is refused. A name clash with
 * another file gets the writer's " (2)" — nothing is ever replaced.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { saveBytesToStore, StoreFrozenFileError } from "./writer"
import { effectiveKind, ownersAreaUserId } from "./structure"
import {
  DROP_FOLDER_NAME, DROP_FOLDER_SETTING, DROP_KEY_PREFIX, DROP_LIMITS,
  checkDropContent, checkDropName, checkDropSubfolder, decodeDropContent, dropCallerKey, dropRateRefusal, sha256Of,
  type RecentDrops,
} from "./my-files-drop-rules"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* tables are not in the generated types
const db = () => supabaseAdmin as any

export interface DropCaller { method: string; email: string }
export interface DropInput { name: unknown; subfolder?: unknown; text?: unknown; content_base64?: unknown; caller_key?: unknown }
export type DropResult =
  | { ok: true; status: "created" | "unchanged"; path: string; name: string; size: number; sha256_prefix: string; note: string }
  | { ok: false; error: string }

export const dropEnabled = (): boolean => process.env.MY_FILES_DROP_ENABLED === "1"

const fail = (error: string): DropResult => ({ ok: false, error })
const ALREADY_SAVED = "(already saved earlier — its current place is not shown)"
const INTERNAL = "The file could not be saved right now. Nothing was changed; try again in a minute."

/** The owner's private My files area (must already exist — this tool never creates an area). */
async function resolveArea(): Promise<{ ownerId: string; userId: string; rootId: string } | string> {
  const userId = await ownersAreaUserId()
  if (!userId) return "The owner's login was not found, so there is no My files to save into."
  const { data: o, error } = await db().from("store_owners").select("id").eq("kind", "private").eq("private_user_id", userId).maybeSingle()
  if (error) throw new Error(`owner lookup: ${error.message}`)
  if (!o) return "The owner has no My files yet — open the Storage page once, then try again."
  const { data: root, error: rErr } = await db().from("store_folders").select("id")
    .eq("owner_id", o.id).eq("kind", "private_root").is("parent_id", null).is("trashed_at", null).maybeSingle()
  if (rErr) throw new Error(`root lookup: ${rErr.message}`)
  if (!root) return "The My files top folder was not found."
  return { ownerId: o.id as string, userId, rootId: root.id as string }
}

/** Is this folder a live, plain folder of this owner whose nearest fixed ancestor is the My files top (NOT "Shared with staff")? */
async function dropFolderOk(folderId: string, ownerId: string): Promise<boolean> {
  const { data: f, error } = await db().from("store_folders").select("id, owner_id, kind, trashed_at").eq("id", folderId).maybeSingle()
  if (error) throw new Error(`drop folder lookup: ${error.message}`)
  if (!f || f.owner_id !== ownerId || f.trashed_at || f.kind !== "custom") return false
  try { return (await effectiveKind(folderId)) === "private_root" } catch { return false }
}

/** The drop folder id: the remembered one if it still checks out, else (re)made under the top folder and remembered. */
async function dropFolder(area: { ownerId: string; rootId: string }): Promise<string> {
  const { data: row, error } = await db().from("app_settings").select("value").eq("key", DROP_FOLDER_SETTING).maybeSingle()
  if (error) throw new Error(`setting read: ${error.message}`) // a read error must NOT look like "no folder yet"
  const remembered = typeof row?.value === "string" ? (row.value as string) : null
  if (remembered && (await dropFolderOk(remembered, area.ownerId))) return remembered
  const { data: id, error: fErr } = await db().rpc("store_ensure_folder_path", { p_owner: area.ownerId, p_parent: area.rootId, p_path: [DROP_FOLDER_NAME], p_actor: null })
  if (fErr || !id) throw new Error(`drop folder: ${fErr?.message ?? "no id"}`)
  if (!(await dropFolderOk(id as string, area.ownerId))) throw new Error("drop folder: the folder named like it is not a plain folder of My files")
  const { error: wErr } = await db().from("app_settings").upsert({ key: DROP_FOLDER_SETTING, value: id, updated_at: new Date().toISOString() }, { onConflict: "key" })
  if (wErr) throw new Error(`setting write: ${wErr.message}`)
  return id as string
}

/** "My files › From Claude › Plans" from the file's REAL folder (it may have been moved or renamed since). */
async function pathOfFolder(folderId: string): Promise<string> {
  const names: string[] = []
  let cur: string | null = folderId
  for (let i = 0; i < 50 && cur; i++) {
    const { data: f, error } = await db().from("store_folders").select("name, parent_id").eq("id", cur).maybeSingle()
    if (error || !f) break
    names.unshift(f.name as string)
    cur = f.parent_id as string | null
  }
  return names.join(" › ")
}

async function recentDrops(ownerId: string): Promise<RecentDrops> {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString()
  const { data, error } = await db().from("store_events").select("occurred_at, details")
    .eq("event", "created").eq("owner_id", ownerId).like("details->>caller_key", `${DROP_KEY_PREFIX}%`).gte("occurred_at", since).limit(1000)
  if (error) throw new Error(`rate lookup: ${error.message}`)
  const hourAgo = Date.now() - 3600_000
  let lastHour = 0
  let bytes = 0
  for (const e of (data ?? []) as Array<{ occurred_at: string; details: { size?: number | string } | null }>) {
    if (new Date(e.occurred_at).getTime() >= hourAgo) lastHour++
    bytes += Number(e.details?.size ?? 0) || 0
  }
  return { lastHour, lastDay: (data ?? []).length, bytesLastDay: bytes }
}

/** The file that already holds this key (any state but purged), with its current content hash. */
async function fileForKey(key: string): Promise<{ id: string; ownerId: string; folderId: string; name: string; state: string; sha: string | null } | null> {
  const { data: f, error } = await db().from("store_files").select("id, owner_id, folder_id, name, state, current_version_id").eq("caller_key", key).neq("state", "purged").maybeSingle()
  if (error) throw new Error(`key lookup: ${error.message}`)
  if (!f) return null
  let sha: string | null = null
  if (f.current_version_id) {
    const { data: v, error: vErr } = await db().from("store_file_versions").select("sha256").eq("id", f.current_version_id).maybeSingle()
    if (vErr) throw new Error(`version lookup: ${vErr.message}`)
    sha = (v?.sha256 as string | undefined) ?? null
  }
  return { id: f.id as string, ownerId: f.owner_id as string, folderId: f.folder_id as string, name: f.name as string, state: f.state as string, sha }
}

async function audit(caller: DropCaller, d: { status: string; path: string; name: string; size: number; sha256: string; key: string; fileId: string }): Promise<void> {
  const { error } = await db().from("action_log").insert({
    actor: "claude.mcp", action_type: "create", table_name: "store_files", record_id: d.fileId,
    summary: `my_files_save: ${d.status} "${d.name}" in ${d.path}`,
    details: { tool: "my_files_save", status: d.status, path: d.path, size: d.size, sha256: d.sha256, caller_key: d.key, auth_method: caller.method, caller_email: caller.email, untrusted_ai_content: true },
  })
  if (error) console.error("[my-files-drop] AUDIT WRITE FAILED:", error.message) // the store_events row still exists
}

export async function saveToMyFilesDrop(input: DropInput, caller: DropCaller): Promise<DropResult> {
  try {
    if (!dropEnabled()) return fail("This tool is switched off. It is turned on with the setting MY_FILES_DROP_ENABLED=1.")

    const nm = checkDropName(input.name)
    if (nm.ok === false) return fail(nm.error)
    const sub = checkDropSubfolder(input.subfolder)
    if (sub.ok === false) return fail(sub.error)
    const body = decodeDropContent(input.text, input.content_base64)
    if (body.ok === false) return fail(body.error)
    const content = checkDropContent(nm.ext, body.bytes)
    if (content.ok === false) return fail(content.error)
    const sha = sha256Of(body.bytes)
    const k = dropCallerKey(input.caller_key, sub.segments, nm.name, sha)
    if (k.ok === false) return fail(k.error)

    const area = await resolveArea()
    if (typeof area === "string") return fail(area)

    // a key that is already used: the same content is a no-op; different content or a deleted file is refused
    const existing = await fileForKey(k.key)
    if (existing) {
      if (existing.ownerId !== area.ownerId) return fail(INTERNAL)
      if (existing.state === "trashed") return fail("That file was deleted from Storage earlier. Use a new caller_key to save it again.")
      if (existing.sha !== sha) return fail("This caller_key already holds a different file. Use a new caller_key (or leave caller_key out) to save this content.")
      // write-only: say nothing about where the file is NOW (Antonio may have renamed or moved it into other private folders)
      return { ok: true, status: "unchanged", path: ALREADY_SAVED, name: nm.name, size: body.bytes.length, sha256_prefix: sha.slice(0, 12), note: "The identical file was already saved; no second copy was made." }
    }

    const recent = await recentDrops(area.ownerId)
    const limited = dropRateRefusal(recent, body.bytes.length)
    if (limited) return fail(limited)

    const drop = await dropFolder(area)
    let target = drop
    if (sub.segments.length) {
      const { data: id, error } = await db().rpc("store_ensure_folder_path", { p_owner: area.ownerId, p_parent: drop, p_path: sub.segments, p_actor: null })
      if (error || !id) throw new Error(`subfolder: ${error?.message ?? "no id"}`)
      target = id as string
    }

    let res
    try {
      res = await saveBytesToStore({
        ownerId: area.ownerId, folderId: target, name: nm.name, mimeType: nm.mime, callerKey: k.key,
        contentChanged: false, // write-once: an existing key can only ever answer "unchanged", never add a version
        published: false, actor: null, documentType: null, skipAnalysis: true, bytes: body.bytes,
        facts: [{ key: "saved_by", value: "Claude session via MCP my_files_save — untrusted AI-session content, not reviewed", source: "rule" }],
      })
    } catch (e) {
      if (e instanceof StoreFrozenFileError) return fail("That file is marked as filed and cannot be changed. Use a new caller_key.")
      throw e
    }
    if (res.status === "trashed") return fail("That file was deleted from Storage earlier. Use a new caller_key to save it again.")

    // a simultaneous save of different content under the same key lands here as "unchanged": make sure what is stored is OUR content
    let stored
    try { stored = await fileForKey(k.key) } catch (e) { console.error("[my-files-drop] re-check failed:", e instanceof Error ? e.message : e); stored = null }
    if (!stored) return fail("The file may have been saved, but this could not be confirmed. Retry with the same caller_key (it is safe: a saved file is not duplicated).")
    if (stored.ownerId !== area.ownerId) return fail(INTERNAL)
    if (stored.sha !== sha) return fail("This caller_key was just used for a different file. Use a new caller_key.")

    const status = res.status === "created" ? "created" : "unchanged"
    const folderPath = await pathOfFolder(stored.folderId)
    const path = status === "created" ? `${folderPath} › ${stored.name}` : ALREADY_SAVED
    await audit(caller, { status, path: folderPath, name: stored.name, size: body.bytes.length, sha256: sha, key: k.key, fileId: stored.id })
    return {
      ok: true, status, path, name: stored.name, size: body.bytes.length, sha256_prefix: sha.slice(0, 12),
      note: status === "created" ? (stored.name !== nm.name ? `A file named "${nm.name}" already existed, so this one was saved as "${stored.name}".` : "Saved.") : "The identical file was already saved; no second copy was made.",
    }
  } catch (e) {
    console.error("[my-files-drop] failed:", e instanceof Error ? e.message : e) // the real reason stays in the server log, never in the answer
    return fail(INTERNAL)
  }
}

export { DROP_LIMITS }
