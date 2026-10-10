/**
 * CRM Store — BIG files from Drive (job 3f81339a; Antonio 2026-10-09: "our storage can't have a limit").
 *
 * The plan build used to download a Drive file whole into memory and refuse anything over 50 MB. The storage itself
 * never had that limit (the buckets have none; production's project-wide limit is 500 GB). Now a file over
 * STREAM_THRESHOLD_BYTES is NOT held in memory: Drive's bytes are piped through a hash into the staging area, checked
 * against the size and md5 the approved plan expects, and registered through the same slot / move / write path the
 * browser upload uses (registerNow). Smaller files, and a document merged with its signing certificates (the merge
 * needs the whole PDF in memory), keep the old path.
 */

import { createHash } from "crypto"
import { Readable, Transform } from "stream"
import { pipeline } from "stream/promises"
import { supabaseAdmin } from "@/lib/supabase-admin"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
const db = () => supabaseAdmin as any

/** above this a file is streamed, never buffered */
export const STREAM_THRESHOLD_BYTES = 40 * 1024 * 1024
/** a document + its signing certificates are merged in memory, so that merged set keeps a ceiling */
export const MERGE_MAX_BYTES = 50 * 1024 * 1024

export type TransferMode = "buffer" | "stream"

/** Pure: how one plan item's bytes travel. A merge always buffers; a lone file over the threshold streams. */
export function transferMode(sourceBytes: number, appendedCount: number): TransferMode {
  return appendedCount === 0 && sourceBytes > STREAM_THRESHOLD_BYTES ? "stream" : "buffer"
}

/**
 * Not a storage limit (the storage has none): the time a single build request may run. Measured on the sandbox, a real
 * Drive file costs ~0.15 s per MB to stream out of Drive (80 MB in 12 s) plus ~0.06 s per MB to register (600 MB in 36 s),
 * i.e. ~0.21 s per MB, so the 300 s request window holds ~1.4 GB; this is set inside it. Above it the build fails with a
 * clear reason instead of timing out and retrying forever — such a file goes in through the staff upload in the CRM,
 * which has no time window. Raise it only with a measured run.
 */
export const STREAM_MAX_BYTES = 1024 * 1024 * 1024

/** Pure: a lone file too big to finish inside one build request. */
export function streamTooLarge(sourceBytes: number, appendedCount: number): boolean {
  return appendedCount === 0 && sourceBytes > STREAM_MAX_BYTES
}

/** Pure: a merged document (source + certificates) over the in-memory ceiling cannot be built. */
export function mergeTooLarge(totalBytes: number, appendedCount: number): boolean {
  return appendedCount > 0 && totalBytes > MERGE_MAX_BYTES
}

export interface StreamDigest { md5: string; sha256: string; bytes: number }

/** A pass-through that hashes everything flowing through it (md5 for Drive's checksum, sha256 for the store). */
export function hashingPassThrough(): { stream: Transform; digest: () => StreamDigest } {
  const md5 = createHash("md5")
  const sha = createHash("sha256")
  let bytes = 0
  const stream = new Transform({
    transform(chunk: Buffer, _enc, cb) { md5.update(chunk); sha.update(chunk); bytes += chunk.length; cb(null, chunk) },
  })
  return { stream, digest: () => ({ md5: md5.digest("hex"), sha256: sha.digest("hex"), bytes }) }
}

/**
 * Pipe a web byte stream into a Storage object, hashing on the way. Returns the digest once the object is stored.
 * (The storage client sends a Node stream with duplex "half".)
 */
export async function pipeToObject(p: { body: ReadableStream<Uint8Array>; bucket: string; path: string; contentType: string }): Promise<StreamDigest> {
  const { stream, digest } = hashingPassThrough()
  const source = Readable.fromWeb(p.body as unknown as import("stream/web").ReadableStream)
  // The upload answers either when the whole body has gone (success) or EARLY with an error (the storage refused it).
  // storage-js returns that error instead of rejecting, so waiting for both with Promise.all could hang on a pipeline
  // nobody reads any more: the upload's answer decides, and a refusal tears the stream down at once.
  let pipeErr: unknown = null
  const piping = pipeline(source, stream).catch((e: unknown) => { pipeErr = e })
  const up = await db().storage.from(p.bucket).upload(p.path, stream, { contentType: p.contentType, upsert: false, duplex: "half" }) as { error: { message: string } | null }
  if (up.error) {
    source.destroy()
    stream.destroy()
    await piping
    throw new Error(`store: streamed upload failed — ${up.error.message}`)
  }
  await piping
  if (pipeErr) throw pipeErr instanceof Error ? pipeErr : new Error(String(pipeErr))
  return digest()
}

/**
 * Stream one Drive file into the staging area and prove it is the file the plan approved: same size, same Drive md5,
 * and the stored object is as long as the bytes that flowed. On any mismatch the staged object is removed and the
 * item fails (a retry starts clean).
 */
export async function streamDriveToStaging(p: {
  driveFileId: string; expectedSize: number; expectedMd5: string
  bucket: string; path: string; contentType: string
}): Promise<StreamDigest> {
  const { openBinaryStreamAnyDrive } = await import("@/lib/google-drive")
  const { storedSize } = await import("./writer")
  const { body, size } = await openBinaryStreamAnyDrive(p.driveFileId)
  if (size != null && size !== p.expectedSize) {
    await body.cancel().catch(() => undefined)
    throw new Error(`Drive reports ${size} bytes, the plan expects ${p.expectedSize} — the file changed.`)
  }
  let d: StreamDigest
  try {
    d = await pipeToObject({ body, bucket: p.bucket, path: p.path, contentType: p.contentType })
  } catch (e) {
    await db().storage.from(p.bucket).remove([p.path]).catch(() => undefined)
    throw e
  }
  const bad =
    d.bytes !== p.expectedSize ? `Drive gave ${d.bytes} bytes, the plan expects ${p.expectedSize} — the download is incomplete or the file changed.`
    : d.md5 !== p.expectedMd5 ? "Drive's file does not match the checksum in the plan — the file changed."
    : (await storedSize(p.bucket, p.path).catch(() => -1)) !== d.bytes ? "The staged copy is not as long as the bytes that were sent."
    : null
  if (bad) {
    await db().storage.from(p.bucket).remove([p.path]).catch(() => undefined)
    throw new Error(bad)
  }
  return d
}
