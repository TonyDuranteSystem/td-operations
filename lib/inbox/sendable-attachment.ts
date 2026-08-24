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
import { createHash, randomUUID } from "crypto"
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
  /**
   * Whose file this is, as a bare name — for display on the card.
   */
  ownerLabel?: string
  /**
   * The CLIENT this file belongs to, as a stable id — what the mixed-client
   * check compares. Deliberately NOT the label: a company and the person behind
   * it have different names but are the same client, so comparing names would
   * flag "Acme's articles + its owner's ITIN" as a mix when it is not one.
   */
  ownerKey?: string
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
  ownerLabel?: string
  ownerKey?: string
  /**
   * TRUE when we made this copy for the send (a chat file or a stored document).
   * FALSE for a panel upload, which is the staff member's own object and must
   * never be deleted by our cleanup — deleting it would pull the file out from
   * under the panel they are still looking at.
   */
  copied?: boolean
}

/**
 * A refusal the staff member should read as-is (too large, unreadable source).
 * Distinct from an unexpected crash so callers can relay the sentence verbatim.
 */
export class SendableRefusal extends Error {}

/**
 * The one oversize sentence. `maxBytes` is the REMAINING budget, so when an
 * earlier file has already used it all the limit is genuinely zero — saying
 * "limit 0.0 MB" then is nonsense; say what actually happened instead.
 */
function oversizeRefusal(name: string, size: number, maxBytes: number): SendableRefusal {
  if (maxBytes <= 0) {
    return new SendableRefusal(
      `"${name}" won't fit — the earlier attachments already use the whole size limit Gmail allows on one email. Send it separately.`,
    )
  }
  return new SendableRefusal(
    `"${name}" is ${formatBytes(size)} — Gmail won't accept an email that big (room left: ${formatBytes(maxBytes)}). I can send the email without it.`,
  )
}

/**
 * A size a human can read. NEVER "0.0 MB" — that is not a size, it is noise
 * sitting where a real number belongs, and it appeared in refusal sentences the
 * same way it appeared on the card ("x.pdf is 0.0 MB — too big, limit 0.0 MB",
 * which reads as gibberish when a cumulative budget has been exhausted).
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
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
  if (bytes.length > maxBytes) throw oversizeRefusal(file.name, bytes.length, maxBytes)
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
    ownerLabel: file.ownerLabel,
    ownerKey: file.ownerKey,
    copied: true,
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
  if (fetched.bytes.length > maxBytes) throw oversizeRefusal(fetched.name, fetched.bytes.length, maxBytes)
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
    ownerLabel: file.ownerLabel,
    ownerKey: file.ownerKey,
    copied: true,
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
    if (typeof actual === "number" && actual > maxBytes) throw oversizeRefusal(file.name, actual, maxBytes)
    return {
      path: file.locator,
      name: file.name,
      content_type: sanitizeAttachmentMimeType(file.contentType),
      size: actual,
      origin: file.origin,
      warning: file.warning,
      ownerLabel: file.ownerLabel,
      ownerKey: file.ownerKey,
      // NOT a copy — this object belongs to the staff member's panel. Cleanup
      // must never delete it.
      copied: false,
    }
  }
  if (file.source === "document") return copyDocumentIntoPrivateBucket(file, maxBytes)
  return copyChatAssetIntoPrivateBucket(file, maxBytes)
}

/**
 * Delete copies WE made for a draft that will never be sent.
 *
 * Only objects marked `copied` — a panel upload is the staff member's own file
 * and deleting it would pull it out from under the panel they are looking at.
 * Best-effort: a failure here must never fail the thing that triggered it
 * (a cancel, a supersede, a mid-prepare refusal).
 */
export async function discardCopies(
  attachments: Array<{ path?: string; copied?: boolean }> | null | undefined,
): Promise<void> {
  const paths = (attachments ?? [])
    .filter((a) => a?.copied && typeof a.path === "string" && isValidWorkerUploadPath(a.path))
    .map((a) => a.path as string)
  if (!paths.length) return
  try {
    await supabaseAdmin.storage.from(WORKER_UPLOAD_BUCKET).remove(paths)
  } catch (err) {
    console.warn("[sendable-attachment] could not discard unused copies:", err)
  }
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
 * Files uploaded to THIS worker conversation in an earlier turn (dev job
 * eefac886) — same private worker-attachments bucket as a this-turn upload,
 * so `source: "worker_upload"` (never "chat_asset") is required: that field
 * is what tells the reader to fetch with the service key, not a public URL.
 */
export function sendableFromRecentUploads(
  refs: Array<{ id: string; name?: string; mimetype?: string; size?: number }>,
  startAt = 1,
): SendableFile[] {
  return refs.map((r, i) => ({
    ref: `up${startAt + i}`,
    source: "worker_upload" as const,
    locator: r.id,
    name: r.name || "file",
    contentType: r.mimetype,
    size: r.size,
    origin: "shared earlier in this conversation",
  }))
}

/** One row of `documents`, as the offer-builder below needs it. */
export interface DocumentRowForOffer {
  id: string
  file_name?: string | null
  mime_type?: string | null
  document_type_name?: string | null
  account_id?: string | null
  contact_id?: string | null
  portal_visible?: boolean | null
  flow_stage?: string | null
  service_type?: string | null
  /** Display name of the account/contact the document belongs to. */
  owner_name?: string | null
  /**
   * The CLIENT this file belongs to, once a person has been resolved to their
   * company. Supplied by the caller, which is the only place that can do the
   * lookup; falls back to the row's own ids.
   */
  owner_key?: string | null
}

/**
 * Documents we hold back from clients.
 *
 * TWO RULES, AND BOTH HAVE HISTORY WORTH KEEPING.
 *
 * (1) A FLOW document is judged by the curated portal allowlist — correct for
 * the ~39 flow-stamped rows it was written for (an unsigned prepared return is
 * a working draft, not a client copy).
 *
 * (2) A NAMED list for ordinary documents, which is currently EMPTY. It held
 * the SS-4 until Antonio reversed that rule on 2026-08-04 ("the SS4 visible to
 * the client is ok"), and the shape is kept so the next such document is one
 * line rather than a redesign.
 *
 * WHAT MUST NOT COME BACK: this used to ask `isClientSafeFlowDoc` for
 * EVERYTHING. That is the PORTAL-visibility policy, which fails closed on a
 * document with no flow stage — and only 39 of 4,929 documents are flow-stamped,
 * so it flagged 3,185 of them (65%). A warning on two thirds of everything is a
 * warning nobody reads. Do not reuse a fail-closed visibility policy as a
 * warning rule.
 */
const INTERNAL_DOCUMENT_PATTERNS: Array<{ re: RegExp; why: string }> = [
  // EMPTY, DELIBERATELY. The SS-4 used to be listed here on the standing rule
  // that it never goes to a client. **Antonio reversed that on 2026-08-04:
  // "the SS4 visible to the client is ok."** The list stays as the seam for a
  // future named-internal document; today there is none, so no ordinary
  // document is flagged and the only warnings a staff member sees are about
  // WHOSE file it is — which are the ones worth reading.
]

/** Why this document is one we hold back, or null when it is ordinary. */
export function internalDocumentReason(row: DocumentRowForOffer): string | null {
  // NAMED RULES FIRST, BEFORE "an admin published it" — kept for when the list
  // is non-empty again. The reasoning: a document type we have RULED is never
  // client-facing should still be flagged on a row whose visibility flag says
  // otherwise, because that flag is then more likely a data defect than a
  // decision, and warning costs nothing. (The list is empty today — the SS-4
  // came off it on 2026-08-04.)
  const haystack = `${row.document_type_name ?? ""} ${row.file_name ?? ""}`
  for (const p of INTERNAL_DOCUMENT_PATTERNS) if (p.re.test(haystack)) return p.why
  // For a FLOW document, publishing IS the deliberate decision and wins — that
  // is what the curated allowlist already encodes.
  if (row.portal_visible === true) return null
  // A flow-stamped document: the curated portal allowlist is the right judge.
  if (row.service_type && row.flow_stage) {
    if (!isClientSafeFlowDoc(row.service_type, row.flow_stage, row.portal_visible)) {
      return "this is an internal working document for that service, not a client copy"
    }
  }
  return null
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
  opts: {
    recipientAccountId?: string | null
    recipientContactId?: string | null
    /**
     * EVERY id that is still "this client": the pinned account, the people
     * linked to it, and their other companies.
     *
     * Matching only the one pinned id is not enough, and the everyday case
     * proves it: an ITIN letter belongs to the PERSON, not the company, so on a
     * screen pinned to Acme LLC the owner's own ITIN row (account id null,
     * contact id set) looked like somebody else's file. "Send the accountant
     * the company documents and the owner's ITIN" would have carried a red
     * warning on a perfectly correct email — which is precisely the
     * warning-fatigue this whole rule exists to avoid.
     */
    relatedClientIds?: Iterable<string> | null
  } = {},
): SendableFile[] {
  const family = new Set<string>(opts.relatedClientIds ?? [])
  if (opts.recipientAccountId) family.add(opts.recipientAccountId)
  if (opts.recipientContactId) family.add(opts.recipientContactId)
  return rows.map((r) => {
    const owner = r.owner_name?.trim() || null
    const knowsRecipient = family.size > 0
    const belongsToRecipient =
      (r.account_id && family.has(r.account_id)) || (r.contact_id && family.has(r.contact_id))
    const warnings: string[] = []
    if (knowsRecipient && !belongsToRecipient) {
      warnings.push(
        `⚠️ This file belongs to ${owner ?? "a different client"} — not the client this screen is about. Check before you send it.`,
      )
    }
    const internal = internalDocumentReason(r)
    if (internal) warnings.push(`⚠️ Internal document — ${internal}.`)
    return {
      ref: documentRef(r.id),
      source: "document" as const,
      locator: r.id,
      name: r.file_name || "document",
      contentType: r.mime_type || undefined,
      origin: owner ? `on file for ${owner}` : "on file in the CRM",
      ...(owner ? { ownerLabel: owner } : {}),
      // The canonical client for this file. `owner_key` is supplied by the
      // caller when it has resolved a person to their company; otherwise the
      // row's own ids stand in.
      ...(r.owner_key || r.account_id || r.contact_id
        ? { ownerKey: r.owner_key || r.account_id || r.contact_id || undefined }
        : {}),
      ...(warnings.length ? { warning: warnings.join(" ") } : {}),
    }
  })
}

/**
 * A document's ref, DERIVED FROM THE DOCUMENT — never from its position.
 *
 * Positional numbering broke exactly the way positional numbering always breaks
 * here: the offer list is mutated during a turn (a second search re-offers a
 * file and drops the older entry), so the "next number" was computed from a list
 * that had shrunk, and a third search could mint `d3` a second time. Resolution
 * takes the FIRST match, so "attach d3" would have frozen a different client's
 * document than the one the model was just shown — carrying that file's warning
 * and owner label too, so the card could not reveal the swap.
 *
 * Content-derived means a re-offer produces the SAME ref (idempotent, no dedup
 * needed) and two different documents can never share one. The same lesson is
 * already recorded on the email-attachment refs; this is the sibling that had
 * not learned it.
 */
export function documentRef(documentId: string): string {
  return `d${createHash("sha256").update(documentId).digest("hex").slice(0, 6)}`
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
