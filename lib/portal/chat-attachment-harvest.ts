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
/** How many recent messages to scan for attachments. */
export const CHAT_HARVEST_MESSAGE_LIMIT = 20

export interface PortalChatHarvest {
  imageBlocks: WorkerImageBlock[]
  /** Prose to append to the user body: which images were shown + which docs can be read. */
  note: string
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
  if (!accountId && !contactId) return { imageBlocks: [], note: "" }

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
    return { imageBlocks: [], note: "" }
  }

  // Newest-first already (query orders DESC). Collect refs with their sender, so
  // "shown above" vs "on the thread" reads correctly and admin files can be
  // filtered out when we only want the client's.
  const imageRefs: AttachmentRef[] = []
  const docLines: string[] = []
  for (const row of rows) {
    if (!includeAdmin && row.sender_type === "admin") continue
    for (const ref of attachmentRefsFromChatRow(row)) {
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
  return { imageBlocks: read.imageBlocks, note }
}
