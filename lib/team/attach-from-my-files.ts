/**
 * Copy files from Antonio's My files › "From Claude" into Team Chat's own file storage so a Claude post can carry them as real
 * attachments (dev job f34c915d). The checks live in `readMyFileForChat` (owner session, drop folder only, type block-list, size cap,
 * audit row, rate limit) and in the pure rules (`attach-from-my-files-rules.ts`); this file only does the copy.
 *
 * The copy goes to the PUBLIC `assets` bucket — the same place the TD Talk paperclip uploads — so the link opens without a login.
 * Nothing is posted here: the caller posts the message with the returned attachments, and removes the copies if that post fails.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { readMyFileForChat, type AccessCaller } from "@/lib/crm-store/my-files-access"
import { chatObjectPath, copyContentType } from "@/lib/team/attach-from-my-files-rules"
import type { ChatAttachment } from "@/lib/types"

const BUCKET = "assets"
const COPY_FAILED = "The file could not be copied to chat storage right now. Nothing was posted; try again in a minute."

export type AttachCopyResult =
  | { ok: true; attachments: ChatAttachment[]; paths: string[] }
  | { ok: false; error: string }

/** Remove copies made for a post that did not happen (best effort — an object left behind is small and unlinked). */
export async function removeChatCopies(paths: ReadonlyArray<string>): Promise<void> {
  if (paths.length === 0) return
  try {
    await supabaseAdmin.storage.from(BUCKET).remove([...paths])
  } catch (e) {
    console.error("[team-chat attach] could not remove unused copies:", e instanceof Error ? e.message : e)
  }
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
      attachments.push({ url: pub.publicUrl, name: read.name, mime_type: contentType, size: read.size })
    }
    return { ok: true, attachments, paths }
  } catch (e) {
    console.error("[team-chat attach] failed:", e instanceof Error ? e.message : e)
    await removeChatCopies(paths)
    return { ok: false, error: COPY_FAILED }
  }
}
