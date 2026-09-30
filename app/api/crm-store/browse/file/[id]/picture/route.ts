/**
 * GET /api/crm-store/browse/file/<id>/picture — the file's CURRENT version as a picture a browser can show (job 685467b5, 2026-09-30).
 * An iPhone photo (HEIC/HEIF — e.g. a passport) cannot be opened by a browser, so staff could not LOOK at the file the AI was judging.
 * HEIC/HEIF is converted to JPEG here; a picture the browser already shows is served as it is; anything else is refused.
 * Same staff + storage-access checks as the plain file route; nothing is written anywhere.
 */
export const dynamic = "force-dynamic"
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { denyUnlessStoreStaff, denyUnlessAreaAccess } from "../../../_auth"

const MAX_BYTES = 30 * 1024 * 1024

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  const noAccess = await denyUnlessAreaAccess({ fileId: params.id }, { allowSharedRead: true })
  if (noAccess) return noAccess
  try {
    const { readFileForStaff } = await import("@/lib/crm-store/browse")
    const f = await readFileForStaff(params.id)
    if (f.bytes.length > MAX_BYTES) return NextResponse.json({ error: "The picture is too large to show here — download it instead." }, { status: 413 })
    const { looksLikeHeic, heicToJpeg } = await import("@/lib/crm-store/read-content")
    const { staffFileHeaders, INLINE_SAFE_TYPES } = await import("@/lib/crm-store/serve")
    if (looksLikeHeic(f.name, f.mimeType, f.bytes)) {
      const jpeg = await heicToJpeg(f.bytes)
      return new NextResponse(new Uint8Array(jpeg), { headers: staffFileHeaders("image/jpeg", f.name.replace(/\.(heic|heif)$/i, "") + ".jpg") })
    }
    const mime = (f.mimeType ?? "").split(";")[0].trim().toLowerCase()
    if (mime.startsWith("image/") && INLINE_SAFE_TYPES.has(mime)) return new NextResponse(new Uint8Array(f.bytes), { headers: staffFileHeaders(f.mimeType, f.name) })
    return NextResponse.json({ error: "This is not a picture the browser can show." }, { status: 415 })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The picture is not available." }, { status: 404 })
  }
}
