/**
 * Capture/Share feature — shared storage constants.
 *
 * Kept separate from lib/ai-agent/attachment-reader.ts's own worker-chat path
 * convention on purpose: two unrelated features sharing one bucket should not
 * share one path regex to maintain — a change meant for one could silently
 * loosen or break the other.
 */
import { WORKER_UPLOAD_BUCKET } from "@/lib/ai-agent/attachment-reader"

export { WORKER_UPLOAD_BUCKET }

/**
 * The only object paths this feature accepts, mirroring
 * lib/ai-agent/attachment-reader.ts's WORKER_UPLOAD_PATH: uploads are always
 * minted server-side as `captures/<uuid>.<ext>` (see
 * app/api/captures/upload-url/route.ts), so anything else is a client-supplied
 * path we did not create — reject it rather than trust an arbitrary storage
 * path, which would let one caller read a DIFFERENT feature's private file
 * (e.g. a worker-chat upload) through this feature's own routes.
 */
export const CAPTURE_STORAGE_PATH =
  /^captures\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,8}$/i

export function isValidCapturePath(path: string): boolean {
  return CAPTURE_STORAGE_PATH.test(path)
}
