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

/** Where an offered file physically lives. Closed on purpose — see the header. */
export type SendableSource = "worker_upload" | "chat_asset"

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
}

/** A file resolved to real bytes in the private bucket, ready to freeze. */
export interface MaterializedAttachment {
  path: string
  name: string
  content_type?: string
  /** ACTUAL bytes when we fetched them; undefined when only a declared size existed. */
  size?: number
  origin?: string
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
  return { path, name: file.name, content_type: contentType, size: bytes.length, origin: file.origin }
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
    }
  }
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

/**
 * The line the worker is shown listing what it may attach this turn.
 * Kept here so every surface says the same thing in the same shape.
 */
export function attachableFilesPrompt(files: SendableFile[]): string {
  if (!files.length) return ""
  const list = files.map((f) => `${f.ref} — ${f.name}${f.origin ? ` (${f.origin})` : ""}`).join(", ")
  return `[FILES YOU CAN ATTACH to an email on this turn (use send_email's \`attach\` with the ref): ${list}. Only these — you cannot attach anything else.]`
}
