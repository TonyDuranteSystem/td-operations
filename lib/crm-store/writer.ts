/**
 * CRM Store — the ONE server-side writer (master plan v4.4 §8.5, slice 2; job 685467b5).
 *
 * Every flow that saves a file into the new store goes through here:
 *   saveBytesToStore()      — bytes produced on the server (generated PDFs, form summaries,
 *                             copies from Drive/email).
 *   createUploadIntent()    — a single-use upload slot for a staff BROWSER upload of any
 *                             size (TUS, x-upsert false, straight to the private staging bucket).
 *   registerStagedUpload()  — registers that upload: small files at once, large files in a
 *                             background job (no request time limit), both via registerNow().
 *
 * The decision "new file / new version / already saved / refused (filed) / trashed" is made
 * in ONE database step, store_write(), together with the file's record links, subjects and
 * facts. Identity = the caller key (flow + source record + slot, globally unique); the
 * SHA-256 only decides same vs new version. Bytes live under id-based paths. The writer never
 * deletes an object a saved version refers to (a "lost reply" can't destroy a committed save);
 * anything left by a killed request is swept by cleanupStore().
 */

import { createHash, randomUUID } from "crypto"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isStoreStaffRole } from "./access"

export const STORE_BUCKET = "crm-store"
export const STORE_STAGING_BUCKET = "crm-store-staging"
export const UPLOAD_INTENT_TTL_MINUTES = 120
/** Staged uploads above this size are registered in a background job (hashing streams the whole object). */
export const INLINE_REGISTER_MAX_BYTES = 150 * 1024 * 1024
export const REGISTER_UPLOAD_JOB = "crm_store_register_upload"

// store_* tables/functions are not in the generated types until they reach production.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

export type WriteStatus = "created" | "versioned" | "unchanged" | "frozen" | "trashed"

export interface WriteResult {
  status: WriteStatus
  fileId: string
  versionId: string | null
  name: string
}

/** A save hit a filed (frozen) file with different content. The flow must turn this into an
 *  amended file (tax-return types) or an alarm — never ignore it. */
export class StoreFrozenFileError extends Error {
  constructor(public readonly fileId: string, public readonly fileName: string) {
    super(`"${fileName}" is filed and frozen — save an amended file instead.`)
    this.name = "StoreFrozenFileError"
  }
}

export interface StoreLink { kind: string; recordId: string; stage?: string | null; taxYear?: number | null }
export interface StoreSubject { kind: "person" | "company"; contactId?: string | null; accountId?: string | null; role: string }
export interface StoreFact { key: string; value: string; source?: "human" | "rule" | "ai" }

export interface SaveMeta {
  ownerId: string
  folderId: string
  name: string
  mimeType?: string | null
  /** flow + source record + slot, e.g. "formation-summary:<submission id>:0". null = always a new file. */
  callerKey: string | null
  /** REQUIRED: false when a re-rendered document's meaningful content did not change (never a new version). */
  contentChanged: boolean
  documentType?: string | null
  periodYear?: number | null
  filingStatus?: "none" | "draft" | "filed" | "amended" | null
  /** NEW files only. Omitted = the document type's default (plan 8.4). */
  published?: boolean | null
  /** NEW files only: the file this one replaces (an amended return). Same owner required. */
  supersedesFileId?: string | null
  actor?: string | null
  links?: StoreLink[]
  subjects?: StoreSubject[]
  facts?: StoreFact[]
}

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

export function storeObjectPath(ownerId: string): string {
  return `${ownerId}/${randomUUID()}`
}

function writePayload(m: SaveMeta, path: string, sha256: string, size: number) {
  return {
    owner_id: m.ownerId,
    folder_id: m.folderId,
    caller_key: m.callerKey,
    name: m.name,
    document_type: m.documentType ?? null,
    period_year: m.periodYear ?? null,
    filing_status: m.filingStatus ?? null,
    published: m.published ?? null,
    supersedes_file_id: m.supersedesFileId ?? null,
    bucket: STORE_BUCKET,
    path,
    sha256,
    size,
    mime: m.mimeType ?? null,
    actor: m.actor ?? null,
    content_changed: m.contentChanged,
    links: (m.links ?? []).map((l) => ({ kind: l.kind, record_id: l.recordId, stage: l.stage ?? null, tax_year: l.taxYear ?? null })),
    subjects: (m.subjects ?? []).map((s) => ({ kind: s.kind, contact_id: s.contactId ?? null, account_id: s.accountId ?? null, role: s.role })),
    facts: (m.facts ?? []).map((f) => ({ key: f.key, value: f.value, source: f.source ?? "rule" })),
  }
}

async function callWrite(payload: ReturnType<typeof writePayload>): Promise<WriteResult> {
  const { data, error } = await db().rpc("store_write", { p: payload })
  if (error) throw new Error(`store: could not register the file — ${error.message}`)
  const r = data as { status: WriteStatus; file_id: string; version_id: string | null; name: string }
  return { status: r.status, fileId: r.file_id, versionId: r.version_id, name: r.name }
}

async function removeObject(bucket: string, path: string): Promise<boolean> {
  const { error } = await db().storage.from(bucket).remove([path])
  if (error) console.error(`[crm-store] could not remove ${bucket}/${path}:`, error.message)
  return !error
}

/** Remove a crm-store object ONLY if no saved version refers to it (a lost reply may hide a committed save). */
async function removeIfUnreferenced(path: string): Promise<void> {
  const { data, error } = await db().rpc("store_object_referenced", { p_bucket: STORE_BUCKET, p_path: path })
  if (error || data !== false) return // unknown or referenced → keep; the orphan sweep decides later
  await removeObject(STORE_BUCKET, path)
}

async function finish(result: WriteResult, path: string): Promise<WriteResult> {
  if (result.status === "unchanged" || result.status === "frozen" || result.status === "trashed") await removeIfUnreferenced(path)
  if (result.status === "frozen") throw new StoreFrozenFileError(result.fileId, result.name)
  return result
}

/** The size Storage itself reports for an object (never trust the sender's claim). */
export async function storedSize(bucket: string, path: string): Promise<number> {
  const { data, error } = await db().storage.from(bucket).info(path)
  if (error || !data) throw new Error(`store: stored object not found (${bucket}/${path})`)
  const d = data as { size?: number | string; metadata?: { size?: number | string } }
  const size = Number(d.size ?? d.metadata?.size)
  if (!Number.isFinite(size)) throw new Error(`store: stored object has no size (${bucket}/${path})`)
  return size
}

/**
 * A personal document (passport, ID, proof of address, ITIN papers … — catalog flag `personal`) is saved ONLY
 * into a PERSON's own storage (decision #28: one personal folder per person, shown in each of their
 * companies' "2. Contacts"). Never into a company's folders, whichever screen or flow asks. Checked before
 * any bytes move. Fails closed: if the type or the owner cannot be read, the save is refused.
 */
export class PersonalDocumentMisfileError extends Error {
  constructor() {
    super("This is a personal document — it can only be saved in the person's own storage (it then shows in their company's \"2. Contacts\"), never in a company folder.")
    this.name = "PersonalDocumentMisfileError"
  }
}

export async function assertPersonalGoesToPerson(ownerId: string, documentType: string | null | undefined): Promise<void> {
  if (!documentType) return
  const read = () => Promise.all([
    db().from("catalog_entries").select("metadata").eq("catalog_id", "storage_document_types").eq("slug", documentType).maybeSingle(),
    db().from("store_owners").select("kind").eq("id", ownerId).maybeSingle(),
  ])
  let [{ data: t, error: tErr }, { data: o, error: oErr }] = await read()
  // a one-off read failure (seen in the E2E run) gets ONE retry before the save is refused (it still fails closed)
  if (tErr || oErr || !o) [{ data: t, error: tErr }, { data: o, error: oErr }] = await read()
  if (tErr || oErr || !o) throw new Error("store: could not check where this document may be saved — please try again.")
  const personal = (t?.metadata as { personal?: boolean } | null)?.personal === true
  if (personal && o.kind !== "person") throw new PersonalDocumentMisfileError()
}

/** A storage error worth ONE retry (gateway / unavailable / timeout), never a refusal or a bad request. */
export function isTransientStorageError(message: string | null | undefined): boolean {
  return /bad gateway|gateway time-?out|service unavailable|\b50[234]\b|timed? ?out|ECONNRESET|fetch failed/i.test(message ?? "")
}

/** Save server-side bytes. */
export async function saveBytesToStore(input: SaveMeta & { bytes: Buffer }): Promise<WriteResult> {
  await assertPersonalGoesToPerson(input.ownerId, input.documentType)
  const sha = sha256Hex(input.bytes)
  const path = storeObjectPath(input.ownerId)
  const put = () => db().storage.from(STORE_BUCKET).upload(path, input.bytes, {
    contentType: input.mimeType ?? "application/octet-stream",
    upsert: false,
  })
  let { error: upErr } = await put()
  // one retry on a passing storage-service hiccup (502 / 503 / timeout seen live on the sandbox); if the
  // first attempt had in fact landed, the retry reports "already exists" and the size check below decides
  if (upErr && isTransientStorageError(upErr.message)) {
    await new Promise((r) => setTimeout(r, 750))
    const again = await put()
    upErr = again.error && !/already exists|Duplicate/i.test(again.error.message) ? again.error : null
  }
  if (upErr) throw new Error(`store: upload failed — ${upErr.message}`)

  let result: WriteResult
  try {
    const size = await storedSize(STORE_BUCKET, path)
    if (size !== input.bytes.length) throw new Error(`store: stored size ${size} ≠ ${input.bytes.length} bytes sent`)
    result = await callWrite(writePayload(input, path, sha, size))
  } catch (e) {
    await removeIfUnreferenced(path)
    throw e
  }
  return finish(result, path)
}

export interface UploadIntent {
  intentId: string
  bucket: string
  stagingPath: string
  expiresAt: string
}

/** A single-use upload slot for a staff browser (explicit staff allow-list, checked here too). */
export async function createUploadIntent(p: {
  ownerId: string; folderId: string; fileName: string; mimeType?: string | null
  callerKey?: string | null; actor: string; actorRole: unknown
}): Promise<UploadIntent> {
  if (!isStoreStaffRole(p.actorRole)) throw new Error("store: only staff (admin/team) can upload to the store")
  const { data: folder } = await db().from("store_folders").select("owner_id, trashed_at").eq("id", p.folderId).maybeSingle()
  if (!folder || folder.owner_id !== p.ownerId || folder.trashed_at) {
    throw new Error("store: upload into a live folder of the same client only")
  }
  const id = randomUUID()
  const stagingPath = `${p.actor}/${id}/${randomUUID()}`
  const expiresAt = new Date(Date.now() + UPLOAD_INTENT_TTL_MINUTES * 60_000).toISOString()
  const { error } = await db().from("store_upload_intents").insert({
    id, owner_id: p.ownerId, folder_id: p.folderId, created_by: p.actor,
    file_name: p.fileName, mime_type: p.mimeType ?? null, caller_key: p.callerKey ?? null,
    staging_path: stagingPath, expires_at: expiresAt,
  })
  if (error) throw new Error(`store: could not create the upload slot — ${error.message}`)
  return { intentId: id, bucket: STORE_STAGING_BUCKET, stagingPath, expiresAt }
}

/** Hash an object by streaming it (no whole-file buffer). */
export async function streamSha256(bucket: string, path: string): Promise<{ sha256: string; bytes: number }> {
  const { data, error } = await db().storage.from(bucket).createSignedUrl(path, 3600)
  if (error || !data?.signedUrl) throw new Error(`store: cannot read the object (${error?.message ?? "no url"})`)
  const res = await fetch(data.signedUrl)
  if (!res.ok || !res.body) throw new Error(`store: cannot read the object (HTTP ${res.status})`)
  const hash = createHash("sha256")
  let bytes = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    hash.update(value)
    bytes += value.byteLength
  }
  return { sha256: hash.digest("hex"), bytes }
}

export type RegisterMeta = Pick<SaveMeta, "documentType" | "periodYear" | "filingStatus" | "published" | "supersedesFileId" | "links" | "subjects" | "facts">

/** Register a staff browser upload: small ones now, large ones in a background job. */
export async function registerStagedUpload(p: { intentId: string; actor: string } & RegisterMeta):
  Promise<WriteResult | { status: "queued"; jobId: string }> {
  const { data: slot, error } = await db().from("store_upload_intents")
    .select("id, staging_path, created_by, consumed_at").eq("id", p.intentId).single()
  if (error || !slot || slot.created_by !== p.actor || slot.consumed_at) throw new Error("store: this upload slot is not valid")
  const size = await storedSize(STORE_STAGING_BUCKET, slot.staging_path)
  if (size > INLINE_REGISTER_MAX_BYTES) {
    const { enqueueJob } = await import("@/lib/jobs/queue")
    const { id } = await enqueueJob({
      job_type: REGISTER_UPLOAD_JOB,
      payload: { intent_id: p.intentId, actor: p.actor, meta: p as unknown as Record<string, unknown> } as never,
      related_entity_type: "store_upload_intent",
      related_entity_id: p.intentId,
      created_by: p.actor,
    })
    return { status: "queued", jobId: id }
  }
  return registerNow(p)
}

/** Claim the slot (a lease — a killed attempt can be retried), hash, move, register, finalise. */
export async function registerNow(p: { intentId: string; actor: string } & RegisterMeta): Promise<WriteResult> {
  const { data: claimed, error } = await db().rpc("store_claim_intent", { p_intent_id: p.intentId, p_actor: p.actor })
  if (error || !claimed) throw new Error(error?.message ?? "store: this upload slot is not valid")
  const i = claimed as { owner_id: string; folder_id: string; file_name: string; mime_type: string | null; caller_key: string | null; staging_path: string; dest_path: string }

  await assertPersonalGoesToPerson(i.owner_id, p.documentType)

  // A retry after a move already happened: the object is at dest_path, not in staging any more.
  const { data: inStaging } = await db().storage.from(STORE_STAGING_BUCKET).exists(i.staging_path)
  const bucket = inStaging ? STORE_STAGING_BUCKET : STORE_BUCKET
  const at = inStaging ? i.staging_path : i.dest_path

  const size = await storedSize(bucket, at)
  const { sha256, bytes } = await streamSha256(bucket, at)
  if (bytes !== size) throw new Error(`store: read ${bytes} bytes but Storage reports ${size}`)
  if (inStaging) {
    const { error: mvErr } = await db().storage.from(STORE_STAGING_BUCKET).move(i.staging_path, i.dest_path, { destinationBucket: STORE_BUCKET })
    if (mvErr) throw new Error(`store: could not move the upload into the store — ${mvErr.message}`)
  }

  const result = await callWrite(writePayload({
    ownerId: i.owner_id, folderId: i.folder_id, name: i.file_name, mimeType: i.mime_type,
    callerKey: i.caller_key, contentChanged: true, actor: p.actor,
    documentType: p.documentType, periodYear: p.periodYear, filingStatus: p.filingStatus,
    published: p.published, supersedesFileId: p.supersedesFileId,
    links: p.links, subjects: p.subjects, facts: p.facts,
  }, i.dest_path, sha256, size))
  const { error: finErr } = await db().rpc("store_finalize_intent", { p_intent_id: p.intentId, p_file_id: result.fileId })
  if (finErr) console.error(`[crm-store] could not finalise upload slot ${p.intentId}:`, finErr.message)
  return finish(result, i.dest_path)
}

/** Sweep abandoned upload slots and crm-store objects no version refers to. Safe to repeat. */
export async function cleanupStore(limit = 200): Promise<{ slotsClosed: number; orphansRemoved: number }> {
  let slotsClosed = 0
  const { data: slots, error } = await db().rpc("store_abandoned_intents", { p_limit: limit })
  if (error) throw new Error(`store: cleanup query failed — ${error.message}`)
  for (const s of (slots ?? []) as { id: string; staging_path: string; dest_path: string | null }[]) {
    const ok = await removeObject(STORE_STAGING_BUCKET, s.staging_path)
    if (s.dest_path) await removeIfUnreferenced(s.dest_path)
    if (!ok) continue
    const { error: e2 } = await db().from("store_upload_intents").update({ consumed_at: new Date().toISOString() })
      .eq("id", s.id).is("consumed_at", null)
    if (!e2) slotsClosed++
  }
  let orphansRemoved = 0
  const { data: orphans, error: oErr } = await db().rpc("store_orphan_objects", { p_limit: limit })
  if (oErr) throw new Error(`store: orphan query failed — ${oErr.message}`)
  for (const o of (orphans ?? []) as { path: string }[]) {
    await removeIfUnreferenced(o.path)
    orphansRemoved++
  }
  return { slotsClosed, orphansRemoved }
}
