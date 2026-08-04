/**
 * WHAT THE WORKER MAY ATTACH TO AN OUTBOUND EMAIL — one resolver, every surface.
 *
 * The model never names a storage path, a bucket, a URL or a Drive id. Each
 * surface enumerates the files it is willing to offer THIS turn and mints a
 * short `ref` for each; the model can only say "attach ref2". That direction is
 * the whole safety story: the server decides what is attachable, the model
 * decides nothing but which of the offered files to use, and the human decides
 * whether it goes.
 *
 * WHY THE BYTES ARE COPIED AT PREPARE (and not fetched at confirm):
 * a frozen row used to hold a REFERENCE, and confirm re-read it. That is honest
 * only while the referenced bytes cannot change. The moment sources widen past
 * the private per-turn upload bucket — a public chat asset, and later a Drive
 * document that is overwritten in place at a stable id — the reference stops
 * being a promise about content. Copying into the private bucket at prepare
 * makes the frozen row hold the exact bytes the staff member is approving, and
 * collapses every source into the ONE shape the confirm path, the MIME builder
 * and the card already handle. No union at confirm, no per-source branch at
 * dispatch, no window in which the file changes under the approval.
 *
 * Adding a future source (Drive/CRM documents) = one entry in `fetchBytes`
 * below plus a surface that mints refs for it. Nothing downstream changes.
 */
import { randomUUID } from "crypto"
import { supabaseAdmin } from "@/lib/supabase-admin"
import {
  WORKER_UPLOAD_BUCKET,
  isValidWorkerUploadPath,
  fetchTrustedStorageBytes,
} from "@/lib/ai-agent/attachment-reader"
import { sanitizeAttachmentMimeType } from "@/lib/inbox/email-attachment-staging"
import { isClientSafeFlowDoc } from "@/lib/flows/flow-doc-visibility"

/** Where an offered file physically lives. Closed on purpose — see the header. */
export type SendableSource = "worker_upload" | "chat_asset" | "document"

/**
 * One file a surface is offering the worker this turn.
 *
 * `locator` is SERVER-MINTED and never round-trips through the model: for
 * `worker_upload` it is the private-bucket object path, for `chat_asset` the
 * public storage URL already stored on the chat row.
 */
export interface SendableFile {
  ref: string
  source: SendableSource
  locator: string
  name: string
  contentType?: string
  /** Declared size, if the surface knows one. Never trusted — see `size` below. */
  size?: number
  /**
   * Plain-English provenance, rendered on the Confirm card.
   * "posted in this thread by Luca" / "you uploaded this just now".
   * The card shows a filename; a filename does not say where it came from, and
   * one company's "EIN Letter.pdf" looks exactly like another's.
   */
  origin?: string
  /**
   * A LOUD line on the Confirm card — an internal-only document, or a file that
   * belongs to a different client than the person being emailed.
   *
   * Antonio's explicit decision (2026-08-03): warn, never block. The worker is
   * not crippled by a rule; the human is given the one fact they cannot get from
   * a filename and decides. So this must always be RENDERED — a warning that
   * only exists in a comment is not a warning.
   */
  warning?: string
}

/** A file resolved to real bytes in the private bucket, ready to freeze. */
export interface MaterializedAttachment {
  path: string
  name: string
  content_type?: string
  /** ACTUAL bytes when we fetched them; undefined when only a declared size existed. */
  size?: number
  origin?: string
  warning?: string
}

/**
 * A refusal the staff member should read as-is (too large, unreadable source).
 * Distinct from an unexpected crash so callers can relay the sentence verbatim.
 */
export class SendableRefusal extends Error {}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Extension for the copied object, derived from OUR filename, never from a URL. */
function extensionFor(name: string): string {
  const ext = (name.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8)
  return ext || "bin"
}

/**
 * Real byte size of an object already in the private bucket.
 *
 * The panel's declared size comes from the browser and is the thing the card
 * would otherwise print. Returns undefined rather than 0 on failure — a card
 * reading "0.0 MB" for a 14 MB file is worse than one saying nothing.
 */
async function statWorkerUpload(path: string): Promise<number | undefined> {
  try {
    const slash = path.lastIndexOf("/")
    const dir = slash === -1 ? "" : path.slice(0, slash)
    const file = path.slice(slash + 1)
    const { data } = await supabaseAdmin.storage.from(WORKER_UPLOAD_BUCKET).list(dir, { search: file, limit: 1 })
    const hit = (data ?? []).find((o) => o.name === file)
    const size = (hit?.metadata as { size?: number } | undefined)?.size
    return typeof size === "number" ? size : undefined
  } catch {
    return undefined
  }
}

/**
 * Copy a chat-posted file into the private bucket and return its new path.
 *
 * `fetchTrustedStorageBytes` is reused deliberately: its host allow-list plus
 * `redirect:"manual"` IS the SSRF boundary for these URLs, which travel through
 * jsonb rows. A bespoke fetcher here would re-open what that one closed.
 */
async function copyChatAssetIntoPrivateBucket(file: SendableFile, maxBytes: number): Promise<MaterializedAttachment> {
  let bytes: Buffer
  try {
    bytes = await fetchTrustedStorageBytes({ id: file.locator, name: file.name })
  } catch (err) {
    throw new SendableRefusal(
      `"${file.name}" couldn't be read from the conversation (${err instanceof Error ? err.message : "unknown error"}).`,
    )
  }
  if (bytes.length > maxBytes) {
    throw new SendableRefusal(
      `"${file.name}" is ${mb(bytes.length)} — Gmail won't accept an email that big (limit ${mb(maxBytes)}). I can send the email without it.`,
    )
  }
  const path = `worker-chat/${randomUUID()}.${extensionFor(file.name)}`
  // The declared type came off a chat row (client- or staff-supplied jsonb) and
  // ends up in a MIME header. Shape-check it here, once, rather than trusting it
  // at the header line — the manual composer already does exactly this.
  const contentType = sanitizeAttachmentMimeType(file.contentType)
  const { error } = await supabaseAdmin.storage
    .from(WORKER_UPLOAD_BUCKET)
    .upload(path, bytes, { contentType: contentType || "application/octet-stream", upsert: false })
  if (error) {
    console.error("[sendable-attachment] copy into private bucket failed:", error)
    throw new SendableRefusal(`"${file.name}" couldn't be prepared for sending — please try again.`)
  }
  return {
    path,
    name: file.name,
    content_type: contentType,
    size: bytes.length,
    origin: file.origin,
    warning: file.warning,
  }
}

/**
 * Bytes for a file we hold ON RECORD for a client, from whichever of the two
 * places our documents actually live.
 *
 * `documents.drive_file_id` is NOT always a Drive id — flow uploads and fax
 * attachments store the synthetic `storage:<bucket>/<path>` shape instead, and
 * the bucket VARIES (`flow-uploads`, `fax-attachments`). Parsing the bucket out
 * of the value is the whole trick: the existing document-preview route slices
 * off only the `storage:` prefix and then reads from a hard-coded bucket, which
 * is why it cannot open either of those. Do not copy that.
 *
 * Drive files go through the EXPORT-aware fetcher, because a Google-native Doc
 * or Sheet refuses `alt=media` outright and would fail only at confirm — after
 * the staff member had approved it.
 */
async function fetchDocumentBytes(
  driveFileId: string,
  fallbackName: string,
): Promise<{ bytes: Buffer; name: string; contentType?: string }> {
  if (driveFileId.startsWith("storage:")) {
    const rest = driveFileId.slice("storage:".length)
    const slash = rest.indexOf("/")
    if (slash <= 0) throw new SendableRefusal(`"${fallbackName}" has an unreadable storage location.`)
    const bucket = rest.slice(0, slash)
    const path = rest.slice(slash + 1)
    const { data, error } = await supabaseAdmin.storage.from(bucket).download(path)
    if (error || !data) throw new SendableRefusal(`"${fallbackName}" could not be read from storage.`)
    return { bytes: Buffer.from(await data.arrayBuffer()), name: fallbackName, contentType: data.type || undefined }
  }
  const { downloadFileBinaryForSend } = await import("@/lib/google-drive")
  const drive = await downloadFileBinaryForSend(driveFileId)
  // Keep OUR filename, but honour an extension the export changed (a Google Doc
  // becomes a PDF, and the name has to say so).
  const exportedExt = drive.fileName.match(/\.([a-z0-9]{1,8})$/i)?.[1]
  const ourExt = fallbackName.match(/\.([a-z0-9]{1,8})$/i)?.[1]
  const name =
    exportedExt && exportedExt.toLowerCase() !== (ourExt ?? "").toLowerCase()
      ? `${fallbackName.replace(/\.[a-z0-9]{1,8}$/i, "")}.${exportedExt}`
      : fallbackName
  return { bytes: drive.buffer, name, contentType: drive.mimeType }
}

/** A document on record, fetched and copied into the private bucket. */
async function copyDocumentIntoPrivateBucket(file: SendableFile, maxBytes: number): Promise<MaterializedAttachment> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: row, error } = await (supabaseAdmin as any)
    .from("documents")
    .select("id, file_name, mime_type, drive_file_id")
    .eq("id", file.locator)
    .maybeSingle()
  if (error || !row?.drive_file_id) {
    throw new SendableRefusal(`"${file.name}" is no longer on file — nothing was attached.`)
  }
  let fetched: { bytes: Buffer; name: string; contentType?: string }
  try {
    fetched = await fetchDocumentBytes(row.drive_file_id as string, (row.file_name as string) || file.name)
  } catch (err) {
    if (err instanceof SendableRefusal) throw err
    throw new SendableRefusal(
      `"${file.name}" couldn't be read (${err instanceof Error ? err.message : "unknown error"}).`,
    )
  }
  if (fetched.bytes.length > maxBytes) {
    throw new SendableRefusal(
      `"${fetched.name}" is ${mb(fetched.bytes.length)} — Gmail won't accept an email that big (limit ${mb(maxBytes)}). I can send the email without it.`,
    )
  }
  const contentType = sanitizeAttachmentMimeType(fetched.contentType || (row.mime_type as string | null) || undefined)
  const path = `worker-chat/${randomUUID()}.${extensionFor(fetched.name)}`
  const { error: upErr } = await supabaseAdmin.storage
    .from(WORKER_UPLOAD_BUCKET)
    .upload(path, fetched.bytes, { contentType: contentType || "application/octet-stream", upsert: false })
  if (upErr) {
    console.error("[sendable-attachment] document copy failed:", upErr)
    throw new SendableRefusal(`"${file.name}" couldn't be prepared for sending — please try again.`)
  }
  return {
    path,
    name: fetched.name,
    content_type: contentType,
    size: fetched.bytes.length,
    origin: file.origin,
    warning: file.warning,
  }
}

/**
 * Resolve one offered file to bytes we own. Throws `SendableRefusal` with a
 * sentence meant for the staff member.
 */
export async function materializeSendable(file: SendableFile, maxBytes: number): Promise<MaterializedAttachment> {
  if (file.source === "worker_upload") {
    // Already ours and already in the private bucket — nothing to copy.
    if (!isValidWorkerUploadPath(file.locator)) {
      throw new SendableRefusal(`"${file.name}" can't be attached (invalid upload).`)
    }
    // Prefer the real size; fall back to the declared one for the CHECK so a
    // stat failure cannot turn an oversize file into an unchecked one. (The
    // confirm path re-checks actual bytes regardless — this is the early, and
    // friendlier, refusal.)
    const actual = (await statWorkerUpload(file.locator)) ?? file.size
    if (typeof actual === "number" && actual > maxBytes) {
      throw new SendableRefusal(
        `"${file.name}" is ${mb(actual)} — Gmail won't accept an email that big (limit ${mb(maxBytes)}). I can send the email without it.`,
      )
    }
    return {
      path: file.locator,
      name: file.name,
      content_type: sanitizeAttachmentMimeType(file.contentType),
      size: actual,
      origin: file.origin,
      warning: file.warning,
    }
  }
  if (file.source === "document") return copyDocumentIntoPrivateBucket(file, maxBytes)
  return copyChatAssetIntoPrivateBucket(file, maxBytes)
}

/**
 * Turn the refs a chat row already yields (`attachmentRefsFromChatRow`) into
 * offered files. Same extractor the READER uses, so what the worker can read in
 * a conversation and what it can attach from it are the same set by
 * construction — they cannot drift into "it described a file it cannot send".
 */
export function sendableFromChatRefs(
  refs: Array<{ id: string; name?: string; mimetype?: string; size?: number }>,
  origin: string,
  startAt = 1,
): SendableFile[] {
  return refs.map((r, i) => ({
    ref: `f${startAt + i}`,
    source: "chat_asset" as const,
    locator: r.id,
    name: r.name || "file",
    contentType: r.mimetype,
    size: r.size,
    origin,
  }))
}

/** One row of `documents`, as the offer-builder below needs it. */
export interface DocumentRowForOffer {
  id: string
  file_name?: string | null
  mime_type?: string | null
  account_id?: string | null
  contact_id?: string | null
  portal_visible?: boolean | null
  flow_stage?: string | null
  service_type?: string | null
  /** Display name of the account/contact the document belongs to. */
  owner_name?: string | null
}

/**
 * Offer a client's stored document as an email attachment — WITH the two facts
 * a filename cannot carry.
 *
 * 1. WHOSE it is. "EIN Letter.pdf" is identical across every company we serve.
 *    When the surface knows which client the email is about and the document
 *    belongs to a DIFFERENT one, that is said loudly. It is not blocked:
 *    Antonio, 2026-08-03 — "let it through with a loud warning on the card".
 *    Emailing one client's document to their own accountant is legitimate and
 *    common; only the human can tell that apart from a mistake.
 * 2. Whether it is one we hold back from clients. The signed SS-4 carries the
 *    responsible party's tax ID and must never reach a client; the unsigned
 *    prepared return is a working draft. `isClientSafeFlowDoc` is the existing
 *    curation point for that and is reused rather than re-decided here.
 *
 * `recipientClientKey` is the account/contact id the surface is pinned to, or
 * null off a client screen (a team channel) — in which case no mismatch can be
 * asserted and none is claimed.
 */
export function sendableFromDocumentRows(
  rows: DocumentRowForOffer[],
  opts: { recipientAccountId?: string | null; recipientContactId?: string | null; startAt?: number } = {},
): SendableFile[] {
  const startAt = opts.startAt ?? 1
  return rows.map((r, i) => {
    const owner = r.owner_name?.trim() || null
    const knowsRecipient = Boolean(opts.recipientAccountId || opts.recipientContactId)
    const belongsToRecipient =
      (opts.recipientAccountId && r.account_id === opts.recipientAccountId) ||
      (opts.recipientContactId && r.contact_id === opts.recipientContactId)
    const warnings: string[] = []
    if (knowsRecipient && !belongsToRecipient) {
      warnings.push(
        `⚠️ This file belongs to ${owner ?? "a different client"} — not the client this screen is about. Check before you send it.`,
      )
    }
    if (!isClientSafeFlowDoc(r.service_type, r.flow_stage, r.portal_visible)) {
      warnings.push("⚠️ Internal document — we do not normally share this one with clients.")
    }
    return {
      ref: `d${startAt + i}`,
      source: "document" as const,
      locator: r.id,
      name: r.file_name || "document",
      contentType: r.mime_type || undefined,
      origin: owner ? `on file for ${owner}` : "on file in the CRM",
      ...(warnings.length ? { warning: warnings.join(" ") } : {}),
    }
  })
}

/**
 * The line the worker is shown listing what it may attach this turn.
 * Kept here so every surface says the same thing in the same shape.
 */
export function attachableFilesPrompt(files: SendableFile[]): string {
  if (!files.length) return ""
  const list = files
    .map((f) => `${f.ref} — ${f.name}${f.origin ? ` (${f.origin})` : ""}${f.warning ? ` [${f.warning}]` : ""}`)
    .join(", ")
  return `[FILES YOU CAN ATTACH to an email on this turn (use send_email's \`attach\` with the ref, several refs for several files): ${list}. Only these — you cannot attach anything else. Where a file carries a warning, REPEAT that warning in your reply so the staff member reads it before confirming; never attach such a file silently.]`
}
