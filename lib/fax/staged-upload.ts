/**
 * Fax — big files without the 4.5 MB request limit (bug-hunter round 2, item 5).
 * The browser asks `/api/tools/fax/upload-url` for a signed upload address, sends the file DIRECT to the private bucket under
 * `fax-upload/<uuid>.<ext>`, and the send route is given only that path and reads the bytes itself (then removes the staged file).
 * The path shape is enforced again at send time: the client never chooses it.
 */
export const FAX_STAGING_BUCKET = 'worker-attachments'
export const FAX_STAGING_PREFIX = 'fax-upload/'
export const FAX_UPLOAD_MAX_MB = 10
export const FAX_UPLOAD_MAX_BYTES = FAX_UPLOAD_MAX_MB * 1024 * 1024
/** Files up to this size travel inside the request as base64 (a request may not exceed 4.5 MB); bigger ones are staged. */
export const FAX_INLINE_MAX_BYTES = 3 * 1024 * 1024

const STAGING_PATH = /^fax-upload\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,8}$/

export function isFaxStagingPath(p: unknown): p is string {
  return typeof p === 'string' && STAGING_PATH.test(p)
}

/** Only these endings are ever used in the path (a file name must never leak a fragment into it); anything else becomes ".bin". */
const STAGING_EXTENSIONS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'gif', 'webp', 'bmp', 'heic'])

export function faxStagingPathFor(uuid: string, fileName: string): string {
  const raw = (fileName.includes('.') ? fileName.split('.').pop() : '') ?? ''
  const ext = raw.toLowerCase()
  return `${FAX_STAGING_PREFIX}${uuid}.${STAGING_EXTENSIONS.has(ext) ? ext : 'bin'}`
}

/** Pure: the plain sentence when a file is too big even for the staged upload (null = fine). */
export function faxSizeProblem(bytes: number): string | null {
  return bytes > FAX_UPLOAD_MAX_BYTES ? `This file is too big to fax (${(bytes / 1024 / 1024).toFixed(1)} MB; the most is ${FAX_UPLOAD_MAX_MB} MB). Make it smaller.` : null
}
