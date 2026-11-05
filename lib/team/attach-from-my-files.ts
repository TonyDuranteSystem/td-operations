/**
 * Copy files from Antonio's My files › "From Claude" into Team Chat's own file storage so a Claude post can carry them as real
 * attachments (dev job f34c915d). The checks live in `readMyFileForChat` (owner session, drop folder only, type block-list, size cap,
 * audit row, rate limit) and in the pure rules (`attach-from-my-files-rules.ts`); this file only does the copy.
 *
 * The copy goes to the PUBLIC `assets` bucket — the same place the TD Talk paperclip uploads — so the link opens without a login.
 * Nothing is posted here: the caller posts the message with the returned attachments, and removes the copies if that post fails.
 * Every copy that is made writes its own audit row (file id, name, public path and link) so a public link can always be traced back
 * to the private file it came from; if that row cannot be written the copy is removed and nothing is attached.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { readMyFileForChat, type AccessCaller } from "@/lib/crm-store/my-files-access"
import { chatObjectPath, copyContentType } from "@/lib/team/attach-from-my-files-rules"
import type { ChatAttachment } from "@/lib/types"

const BUCKET = "assets"
const COPY_FAILED = "The file could not be copied to chat storage right now. Nothing was posted; try again in a minute."
/** Not one of the two `my_files_*` types, so these rows never count against the My files hourly limits. */
const PUBLISH_ACTION_TYPE = "team_chat_attach_publish"

export type AttachCopyResult =
  | { ok: true; attachments: ChatAttachment[]; paths: string[] }
  | { ok: false; error: string }

/**
 * Remove copies made for a post that did not happen. Returns the paths that could NOT be removed (empty when all are gone).
 * Storage reports a failed removal as `{ error }` instead of throwing, so both are caught and logged with the paths — a copy left behind
 * is public, and this log line plus its audit row are the only trace of where it is.
 */
export async function removeChatCopies(paths: ReadonlyArray<string>): Promise<string[]> {
  if (paths.length === 0) return []
  try {
    const { error } = await supabaseAdmin.storage.from(BUCKET).remove([...paths])
    if (error) {
      console.error("[team-chat attach] COPIES NOT REMOVED:", error.message, JSON.stringify(paths))
      return [...paths]
    }
    return []
  } catch (e) {
    console.error("[team-chat attach] COPIES NOT REMOVED:", e instanceof Error ? e.message : e, JSON.stringify(paths))
    return [...paths]
  }
}

/** One audit row per public copy. Throws when it cannot be written (the caller then removes the copy). */
async function auditPublishedCopy(caller: AccessCaller, copy: { fileId: string; name: string; size: number; path: string; url: string }): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- action_log insert shape is loose
  const { error } = await (supabaseAdmin as any).from("action_log").insert({
    actor: "claude.mcp", action_type: PUBLISH_ACTION_TYPE, table_name: "store_files", record_id: copy.fileId,
    summary: `team_chat_attach: published a copy of "${copy.name}" to chat storage`,
    details: {
      tool: "team_chat_attach", auth_method: caller.method, caller_email: caller.email, untrusted_ai_content: true,
      file_id: copy.fileId, file_name: copy.name, size: copy.size, public_path: copy.path, public_url: copy.url, bucket: BUCKET,
    },
  })
  if (error) throw new Error(`audit insert: ${error.message}`)
}

/** Read each named My files file (all checks inside) and copy it to chat storage. All or nothing: one refusal removes the copies already made. */
export async function attachMyFilesToChat(fileIds: ReadonlyArray<string>, caller: AccessCaller): Promise<AttachCopyResult> {
  const paths: string[] = []
  const attachments: ChatAttachment[] = []
  try {
    for (const id of fileIds) {
      const read = await readMyFileForChat({ file_id: id }, caller)
      if (read.ok === false) {
        await removeChatCopies(paths)
        return { ok: false, error: read.error }
      }
      const contentType = copyContentType(read.mime_type)
      const path = chatObjectPath(read.name)
      const { error: upErr } = await supabaseAdmin.storage.from(BUCKET).upload(path, read.bytes, { contentType, upsert: false })
      if (upErr) {
        console.error("[team-chat attach] upload failed:", upErr.message)
        await removeChatCopies(paths)
        return { ok: false, error: `"${read.name}": ${COPY_FAILED}` }
      }
      paths.push(path)
      const { data: pub } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(path)
      await auditPublishedCopy(caller, { fileId: read.file_id, name: read.name, size: read.size, path, url: pub.publicUrl })
      attachments.push({ url: pub.publicUrl, name: read.name, mime_type: contentType, size: read.size })
    }
    return { ok: true, attachments, paths }
  } catch (e) {
    console.error("[team-chat attach] failed:", e instanceof Error ? e.message : e)
    await removeChatCopies(paths)
    return { ok: false, error: COPY_FAILED }
  }
}
