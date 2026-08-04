/**
 * Resolve what a client attached in a portal chat, for the worker.
 *
 * The twin of `lib/inbox/email-attachments.ts::harvestEmailAttachments`, for the
 * portal-chat surfaces (the Portal Chats "Worker" tab and the "Suggest reply"
 * button). Lives in lib/ (not inside a route) so the SCOPE FILTER and the caps
 * are testable — the scope is the exact thing that silently reads the wrong
 * client if it drifts.
 *
 * Two treatments, same rationale as email:
 *  - IMAGES are downloaded and returned as at-door blocks so the worker SEES the
 *    screenshot. A tool it must choose to call is a tool it skips, then it
 *    answers about a screenshot it never looked at.
 *  - NON-IMAGE files (PDF/Word/Excel/CSV) are only LISTED with their link. The
 *    worker already has `read_portal_attachment` to pull one on demand; decoding
 *    every document in a long chat up-front would burn tokens on files nobody
 *    asked about.
 *
 * Messages are walked NEWEST-FIRST and the image budget is small, so the
 * screenshot the client just sent is the one that reaches the model — not three
 * older ones that fill the budget first.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import {
  readAttachments,
  fetchTrustedStorageBytes,
  attachmentRefsFromChatRow,
  MAX_IMAGE_BYTES,
  type AttachmentRef,
} from "@/lib/ai-agent/attachment-reader"
import type { WorkerImageBlock } from "@/lib/ai-agent/worker-tools"

/** Images attached to the user turn — each is re-sent every loop iteration, so keep it small. */
export const MAX_CHAT_IMAGES = 3
/** How many of this chat's files may be offered as email attachments at once. */
export const MAX_ATTACHABLE_CHAT_FILES = 10
/** How many recent messages to scan for attachments. */
export const CHAT_HARVEST_MESSAGE_LIMIT = 20

export interface PortalChatHarvest {
  imageBlocks: WorkerImageBlock[]
  /** Prose to append to the user body: which images were shown + which docs can be read. */
  note: string
  /**
   * The same files, as refs the caller can offer as EMAIL ATTACHMENTS.
   *
   * Forwarding what a client posted (their bank letter, their signed form) to
   * our accountant is an everyday move, and until now the worker could read
   * those files here but not attach one. Returned as refs, not paths or bytes:
   * the surface mints the attach-list, the model only ever names a ref.
   */
  files: AttachmentRef[]
}

interface HarvestOpts {
  accountId?: string | null
  contactId?: string | null
  /** Only the client's own attachments (the reported bug), or admin's too. Default: client only. */
  includeAdmin?: boolean
}

/**
 * The SAME union the staff panel and the Suggest route use: portal messages live
 * under BOTH account_id and contact_id — admin replies are account-scoped,
 * "person"-tagged client messages are contact-scoped with account_id NULL. Keying
 * on one id alone silently misses the client's person-tagged screenshots, which
 * is exactly where a screenshot lands. Do not hand-roll a narrower filter.
 */
function scopedQuery(accountId?: string | null, contactId?: string | null) {
  let q = supabaseAdmin
    .from("portal_messages")
    .select("sender_type, message, attachment_url, attachment_name, attachments, created_at")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(CHAT_HARVEST_MESSAGE_LIMIT)

  if (accountId && contactId) {
    q = q.or(`account_id.eq.${accountId},and(contact_id.eq.${contactId},account_id.is.null)`)
  } else if (accountId) {
    q = q.eq("account_id", accountId)
  } else if (contactId) {
    q = q.eq("contact_id", contactId).is("account_id", null)
  }
  return q
}

/**
 * Best-effort: any failure returns an empty harvest so the worker still answers
 * from text. Never throws.
 */
export async function harvestPortalChatAttachments(opts: HarvestOpts): Promise<PortalChatHarvest> {
  const { accountId, contactId, includeAdmin = false } = opts
  if (!accountId && !contactId) return { imageBlocks: [], note: "", files: [] }

  let rows: Array<{
    sender_type: string
    attachments?: unknown
    attachment_url?: string | null
    attachment_name?: string | null
    created_at: string
  }> = []
  try {
    const { data } = await scopedQuery(accountId, contactId)
    rows = (data ?? []) as typeof rows
  } catch (err) {
    console.warn("[chat-attachment-harvest] scope query failed:", err)
    return { imageBlocks: [], note: "", files: [] }
  }

  // Newest-first already (query orders DESC). Collect refs with their sender, so
  // "shown above" vs "on the thread" reads correctly and admin files can be
  // filtered out when we only want the client's.
  const imageRefs: AttachmentRef[] = []
  const docLines: string[] = []
  // Every in-scope file, image or not — the attachable set. Bounded by the same
  // message window as the rest of this harvest.
  const allRefs: AttachmentRef[] = []
  for (const row of rows) {
    if (!includeAdmin && row.sender_type === "admin") continue
    for (const ref of attachmentRefsFromChatRow(row)) {
      if (allRefs.length < MAX_ATTACHABLE_CHAT_FILES) allRefs.push(ref)
      const isImage = (ref.mimetype ?? "").startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(ref.name ?? "")
      if (isImage) {
        if (ref.size && ref.size > MAX_IMAGE_BYTES) continue // known-oversized: skip the download
        if (imageRefs.length < MAX_CHAT_IMAGES) imageRefs.push(ref)
      } else {
        // Listed for on-demand reading via read_portal_attachment; capped so a
        // giant chat doesn't dump 40 links into the prompt.
        if (docLines.length < 8) docLines.push(`  📎 ${ref.name ?? "file"} — ${ref.id}`)
      }
    }
  }

  const read = imageRefs.length ? await readAttachments(imageRefs, fetchTrustedStorageBytes) : { imageBlocks: [], textBlocks: [] as string[] }

  const lines: string[] = []
  if (read.imageBlocks.length) {
    lines.push(`Images the client shared (already shown to you above — look at them directly).`)
  }
  // Any per-image note (couldn't download / not a real image) surfaces honestly.
  for (const t of read.textBlocks) {
    if (!t.includes("shown to you above")) lines.push(t)
  }
  if (docLines.length) {
    lines.push("Documents the client shared — call read_portal_attachment with the link to read one:")
    lines.push(...docLines)
  }

  const note = lines.length ? `\n\n--- FILES IN THIS CLIENT CHAT ---\n${lines.join("\n")}` : ""
  return { imageBlocks: read.imageBlocks, note, files: allRefs }
}

/* ------------------------------------------------------------------------- *
 * THE CONVERSATION ITSELF — what the client and we have actually said.
 * ------------------------------------------------------------------------- */

/**
 * How many recent portal messages the worker is handed on EVERY turn.
 *
 * Antonio, 2026-08-01: the worker must not forget what is on the screen in front
 * of the staff member. It is NOT meant to hold the client's whole history — "if I
 * need the worker to go back and read a specific conversation, I can tell him".
 * So this is the visible conversation, not an archive; anything older is reachable
 * with `portal_chat_read` when the staff member asks for it.
 */
export const CHAT_TRANSCRIPT_MESSAGE_LIMIT = 30

/** Per-message cap, so one pasted wall of text cannot crowd out the rest. */
export const CHAT_TRANSCRIPT_PER_MESSAGE_CHARS = 1500

/**
 * The client's portal conversation as plain text, oldest→newest.
 *
 * WHY THIS EXISTS: until 2026-08-01 the Portal Chats worker was handed the client's
 * NAME and nothing else — never a single message, on any turn. It was sitting on a
 * conversation it could not see, and could only reach it by choosing to call a tool.
 * That is the same coin-flip that failed on the Inbox email thread, where the worker
 * told the staff member it could not see an email that had simply been taken away
 * from it after the first turn.
 *
 * Uses the SAME scope union as the attachment harvest above — portal messages live
 * under BOTH account_id and contact_id, and a narrower filter silently misses the
 * client's person-tagged messages.
 *
 * Best-effort: never throws. An empty string means the worker answers from tools
 * alone, exactly as it did before.
 */
export async function buildPortalChatTranscript(opts: {
  accountId?: string | null
  contactId?: string | null
}): Promise<string> {
  const { accountId, contactId } = opts
  if (!accountId && !contactId) return ""

  try {
    let q = supabaseAdmin
      .from("portal_messages")
      .select("sender_type, sender_name, message, created_at")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(CHAT_TRANSCRIPT_MESSAGE_LIMIT)

    if (accountId && contactId) {
      q = q.or(`account_id.eq.${accountId},and(contact_id.eq.${contactId},account_id.is.null)`)
    } else if (accountId) {
      q = q.eq("account_id", accountId)
    } else if (contactId) {
      q = q.eq("contact_id", contactId).is("account_id", null)
    }

    const { data } = await q
    const rows = (data ?? []) as Array<{
      sender_type: string
      sender_name: string | null
      message: string | null
      created_at: string
    }>
    if (!rows.length) return ""

    // Query is newest-first (so the LIMIT keeps the most recent); render oldest-first
    // so the worker reads it the way a person would.
    return rows
      .slice()
      .reverse()
      .map((r) => {
        const who = r.sender_type === "admin" ? `Us (${r.sender_name || "Tony Durante Team"})` : "Client"
        const when = new Date(r.created_at).toISOString().slice(0, 16).replace("T", " ")
        const text = (r.message ?? "").trim().slice(0, CHAT_TRANSCRIPT_PER_MESSAGE_CHARS)
        return `--- ${who} (${when}) ---\n${text || "(no text — attachment only)"}`
      })
      .join("\n\n")
  } catch (err) {
    console.warn("[chat-transcript] query failed:", err)
    return ""
  }
}
